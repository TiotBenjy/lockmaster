// Lecture « à la demande » d'un flux d'octets découpé en morceaux quelconques : les décodeurs xz et
// bzip2 (ADR-0015) lisent des longueurs exactes ou une fenêtre contiguë, sans dépendre du découpage
// de la source. Une fin de flux prématurée est une donnée corrompue (FORMAT_CORRUPT_STREAM).

import { at } from './bytes.js';
import { FormatError, throwIfAborted } from './errors.js';

export class StreamReader {
  readonly #iterator: AsyncIterator<Uint8Array>;
  readonly #signal: AbortSignal | undefined;
  #buffer: Uint8Array = new Uint8Array(0);
  #offset = 0;
  #position = 0;
  #done = false;

  constructor(input: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
    this.#iterator = input[Symbol.asyncIterator]();
    this.#signal = signal;
  }

  /** Nombre d'octets consommés depuis le début du flux. */
  get position(): number {
    return this.#position;
  }

  /** Fenêtre contiguë des `n` prochains octets (moins en fin de flux), sans les consommer. */
  async fill(n: number): Promise<Uint8Array> {
    throwIfAborted(this.#signal);
    while (this.#buffer.length - this.#offset < n && (await this.#pull())) {
      throwIfAborted(this.#signal);
    }
    return this.#buffer.subarray(this.#offset, this.#offset + Math.min(n, this.#buffer.length - this.#offset));
  }

  /** Consomme `n` octets déjà présents dans la fenêtre rendue par `fill`. */
  skip(n: number): void {
    if (n > this.#buffer.length - this.#offset) throw corrupt();
    this.#offset += n;
    this.#position += n;
  }

  async readExact(n: number): Promise<Uint8Array> {
    const window = await this.fill(n);
    if (window.length < n) throw corrupt();
    const copy = window.slice();
    this.skip(n);
    return copy;
  }

  async readByte(): Promise<number> {
    return at(await this.readExact(1), 0);
  }

  async peekByte(): Promise<number | undefined> {
    return (await this.fill(1))[0];
  }

  async atEnd(): Promise<boolean> {
    return (await this.fill(1)).length === 0;
  }

  /** Libère la source (à appeler quand on abandonne la lecture avant la fin). */
  async close(): Promise<void> {
    await this.#iterator.return?.();
  }

  async #pull(): Promise<boolean> {
    if (this.#done) return false;
    const next = await this.#iterator.next();
    if (next.done === true) {
      this.#done = true;
      return false;
    }
    const rest = this.#buffer.subarray(this.#offset);
    this.#buffer = rest.length === 0 ? next.value : concat(rest, next.value);
    this.#offset = 0;
    return true;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

function corrupt(): FormatError {
  return new FormatError('FORMAT_CORRUPT_STREAM', 'flux compressé terminé prématurément');
}
