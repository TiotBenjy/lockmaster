import { createHash } from 'node:crypto';
import { LockmasterError } from '../domain/errors.js';
import type { Clock } from '../domain/ports.js';
import type { SignRequest } from '../domain/signer-protocol.js';
import { type CheckLimits, prepareSignature } from './checks.js';
import type { SignatureJournal } from './journal.js';
import type { KeyRecord, KeyStore } from './keystore.js';
import type { RateLimiter } from './rate-limit.js';

// Demande `sign` (ADR-0009) : clé utilisable (active ou en entrée de rotation, non expirée), limite de
// débit, contrôles propres au type de demande, signature en mémoire, puis entrée `signed` au journal ;
// la signature n'est rendue qu'une fois journalisée. Les refus sont journalisés par le routeur.

export interface SignerSigningDeps {
  keys: KeyStore;
  journal: SignatureJournal;
  clock: Clock;
  rate: RateLimiter;
  limits: CheckLimits;
}

const sha256 = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');

export class SignerSigning {
  readonly #deps: SignerSigningDeps;

  constructor(deps: SignerSigningDeps) {
    this.#deps = deps;
  }

  async sign(request: SignRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const now = this.#deps.clock.now();
    const key = this.#usableKey(request.keyId, now);
    this.#deps.rate.consume(key.id, now.getTime());
    const prepared = prepareSignature(request, key, now, this.#deps.limits);
    const result = await prepared.sign(this.#deps.keys.privateKey(key.id), now);
    // Échéance passée pendant la signature : rien n'est rendu ni journalisé comme signé.
    if (signal?.aborted) throw new LockmasterError('SIGNER_TIMEOUT', 'délai de requête dépassé');
    // Clé relue après l'attente : un retrait d'urgence pendant la signature l'emporte.
    this.#usableKey(key.id, this.#deps.clock.now());
    this.#deps.journal.append({
      at: now.getTime(),
      keyId: key.id,
      kind: request.kind,
      contentSha256: sha256(prepared.content),
      request: prepared.request,
      outcome: 'signed',
    });
    return result;
  }

  #usableKey(keyId: string, now: Date): KeyRecord {
    const key = this.#deps.keys.get(keyId);
    if (!key) throw new LockmasterError('KEY_NOT_FOUND', 'clé inconnue');
    if (key.state === 'retired') throw new LockmasterError('KEY_RETIRED', 'clé retirée');
    if (key.state !== 'active' && key.state !== 'rotating_in') {
      throw new LockmasterError('KEY_STATE_CONFLICT', 'clé qui ne signe plus (rotation en cours)');
    }
    if (key.expiresAt !== null && key.expiresAt <= now.getTime())
      throw new LockmasterError('KEY_EXPIRED', 'clé expirée');
    return key;
  }
}
