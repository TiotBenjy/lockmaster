import { randomBytes, type ScryptOptions, scrypt, timingSafeEqual } from 'node:crypto';
import { LockmasterError } from '../domain/errors.js';

// Hachage des mots de passe (docs/02 §3.3) : scrypt N=2^17, r=8, p=1 (environ 128 Mio, d'où maxmem
// 256 Mio), sel de 16 octets, sortie de 64 octets, format `scrypt$N$r$p$sel$hash` (base64). Au plus
// `concurrency` calculs simultanés et une file bornée (SEC-22) : au-delà, refus immédiat plutôt que
// d'épuiser la mémoire. scrypt tourne dans le pool de fils de libuv, partagé avec les I/O de fichiers et
// le DNS : la concurrence doit y laisser au moins 2 fils libres (UV_THREADPOOL_SIZE, fixé par le lanceur).
// Instance injectée par l'objet Deps (aucun état global).

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export interface PasswordHasherOptions {
  /** Taille du pool de fils de libuv (UV_THREADPOOL_SIZE, 4 par défaut dans Node). */
  threadPoolSize: number;
  params?: ScryptParams;
  concurrency?: number;
  maxQueue?: number;
}

export interface PasswordCheck {
  valid: boolean;
  /** Vrai si l'empreinte a été calculée avec d'autres paramètres : la recalculer après connexion. */
  needsRehash: boolean;
}

const DEFAULT_PARAMS: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const MAX_MEMORY = 256 * 1024 * 1024;
const MAX_PASSWORD_LENGTH = 1024;
const FREE_THREADS = 2;
const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 0x5a);

const invalidHash = () => new LockmasterError('PASSWORD_HASH_INVALID', 'empreinte de mot de passe illisible');
const invalidParams = (reason: string) => new LockmasterError('PASSWORD_PARAMS_INVALID', `scrypt : ${reason}`);
const aborted = () => new LockmasterError('PASSWORD_ABORTED', 'calcul de mot de passe annulé');

const cost = ({ N, r, p }: ScryptParams) => N * r * p;

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEMORY };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

function wellFormed({ N, r, p }: ScryptParams): boolean {
  const powerOfTwo = Number.isSafeInteger(N) && N >= 2 ** 10 && N <= 2 ** 18 && (N & (N - 1)) === 0;
  const small = Number.isSafeInteger(r) && r >= 1 && r <= 32 && Number.isSafeInteger(p) && p >= 1 && p <= 16;
  return powerOfTwo && small && 128 * N * r <= MAX_MEMORY / 2;
}

/** Longueur vérifiée sur la chaîne brute, avant la normalisation NFKC qui peut l'étendre (x18). */
const validPassword = (password: string) => password.length > 0 && password.length <= MAX_PASSWORD_LENGTH;

interface Waiter {
  resolve: () => void;
}

export class PasswordHasher {
  readonly #params: ScryptParams;
  readonly #concurrency: number;
  readonly #maxQueue: number;
  #active = 0;
  readonly #waiting: Waiter[] = [];

  constructor(options: PasswordHasherOptions) {
    this.#params = options.params ?? DEFAULT_PARAMS;
    this.#concurrency = options.concurrency ?? 4;
    this.#maxQueue = options.maxQueue ?? 64;
    if (!wellFormed(this.#params)) throw invalidParams('paramètres hors bornes');
    if (!Number.isSafeInteger(this.#concurrency) || this.#concurrency < 1) throw invalidParams('concurrence invalide');
    if (!Number.isSafeInteger(options.threadPoolSize) || options.threadPoolSize < 1) {
      throw invalidParams('taille du pool de fils invalide (UV_THREADPOOL_SIZE)');
    }
    if (this.#concurrency > options.threadPoolSize - FREE_THREADS) {
      throw invalidParams(
        `concurrence ${this.#concurrency} pour un pool de ${options.threadPoolSize} fils (UV_THREADPOOL_SIZE)`,
      );
    }
  }

  async hash(password: string, signal?: AbortSignal): Promise<string> {
    if (!validPassword(password)) {
      throw new LockmasterError(
        'PASSWORD_INVALID',
        `mot de passe vide ou de plus de ${MAX_PASSWORD_LENGTH} caractères`,
      );
    }
    const salt = randomBytes(SALT_BYTES);
    const key = await this.#limited(() => derive(password, salt, this.#params), signal);
    const { N, r, p } = this.#params;
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
  }

  /** Vérifie un mot de passe ; une empreinte stockée illisible ou hors bornes lève PASSWORD_HASH_INVALID. */
  async verify(password: string, stored: string, signal?: AbortSignal): Promise<PasswordCheck> {
    const { params, salt, hash } = this.#parseStored(stored);
    if (!validPassword(password)) return this.verifyDummy(password, signal);
    const key = await this.#limited(() => derive(password, salt, params), signal);
    const needsRehash = params.N !== this.#params.N || params.r !== this.#params.r || params.p !== this.#params.p;
    return { valid: timingSafeEqual(key, hash), needsRehash };
  }

  /**
   * Calcul complet aux paramètres courants, résultat toujours faux : égalise le temps de réponse d'un
   * compte inconnu. Écart résiduel : une empreinte d'anciens paramètres coûte entre la moitié et le
   * double (bornes de #parseStored) jusqu'à son re-hachage à la connexion suivante.
   */
  async verifyDummy(password: string, signal?: AbortSignal): Promise<PasswordCheck> {
    await this.#limited(() => derive(password.slice(0, MAX_PASSWORD_LENGTH), DUMMY_SALT, this.#params), signal);
    return { valid: false, needsRehash: false };
  }

  /** Empreinte stockée : format strict et coût CPU entre la moitié et le double des paramètres courants. */
  #parseStored(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') throw invalidHash();
    const [N, r, p] = parts.slice(1, 4).map((value) => (/^[0-9]{1,9}$/.test(value) ? Number(value) : Number.NaN));
    const params = { N: N ?? Number.NaN, r: r ?? Number.NaN, p: p ?? Number.NaN };
    const salt = Buffer.from(parts[4] ?? '', 'base64');
    const hash = Buffer.from(parts[5] ?? '', 'base64');
    const current = cost(this.#params);
    const inRange = cost(params) >= current / 2 && cost(params) <= current * 2;
    if (!wellFormed(params) || !inRange || salt.length !== SALT_BYTES || hash.length !== KEY_BYTES) throw invalidHash();
    return { params, salt, hash };
  }

  async #limited<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw aborted();
    if (this.#active >= this.#concurrency) await this.#wait(signal);
    else this.#active += 1;
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      // Le créneau passe directement au suivant ; sinon il est rendu.
      if (next) next.resolve();
      else this.#active -= 1;
    }
  }

  #wait(signal?: AbortSignal): Promise<void> {
    if (this.#waiting.length >= this.#maxQueue) {
      return Promise.reject(new LockmasterError('PASSWORD_HASHER_BUSY', 'trop de calculs de mot de passe en attente'));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const index = this.#waiting.indexOf(waiter);
        if (index >= 0) this.#waiting.splice(index, 1);
        reject(aborted());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiting.push(waiter);
    });
  }
}
