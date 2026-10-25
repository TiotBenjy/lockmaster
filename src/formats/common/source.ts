// Accès en lecture à un paquet non fiable, par plages : les parseurs lisent des en-têtes à des
// positions connues et diffusent les gros membres sans tout charger. L'implémentation sur fichier
// (blob stocké) vit dans src/storage/ ; src/formats/ ne touche jamais au système de fichiers.

import { FormatError, throwIfAborted } from './errors.js';

export interface ByteSource {
  readonly size: number;
  /** Lit exactement `length` octets à `offset` ; le tableau rendu appartient à l'appelant. */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  /** Diffuse exactement la plage `[offset, offset + length)`. */
  stream(offset: number, length: number, signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

/** Vérifie qu'une plage est bien formée et contenue dans `size` octets. */
export function checkRange(size: number, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    throw new FormatError('FORMAT_INVALID', 'plage de lecture invalide');
  }
  if (offset + length > size) {
    throw new FormatError('FORMAT_TRUNCATED', `lecture de ${length} octets à ${offset} au-delà de la fin (${size})`);
  }
}

const DEFAULT_CHUNK_BYTES = 64 * 1024;

/** Source en mémoire (tests, petits contenus déjà chargés). */
export class BufferSource implements ByteSource {
  readonly #bytes: Uint8Array;
  readonly #chunkBytes: number;

  constructor(bytes: Uint8Array, chunkBytes = DEFAULT_CHUNK_BYTES) {
    this.#bytes = bytes;
    this.#chunkBytes = chunkBytes;
  }

  get size(): number {
    return this.#bytes.length;
  }

  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    throwIfAborted(signal);
    checkRange(this.size, offset, length);
    return this.#bytes.slice(offset, offset + length);
  }

  async *stream(offset: number, length: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    checkRange(this.size, offset, length);
    for (let position = offset; position < offset + length; position += this.#chunkBytes) {
      throwIfAborted(signal);
      yield this.#bytes.slice(position, Math.min(position + this.#chunkBytes, offset + length));
    }
    throwIfAborted(signal);
  }
}
