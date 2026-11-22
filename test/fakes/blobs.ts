import { LockmasterError } from '../../src/domain/errors.js';
import { DigestAccumulator } from '../../src/formats/common/digests.js';
import { assertMaxBytes } from '../../src/storage/limits.js';
import { assertSha256 } from '../../src/storage/paths.js';
import type { BlobStore, BlobWriteOptions, BlobWriter, StoredBlob } from '../../src/storage/types.js';

/** Blobs en mémoire, mêmes règles que le stockage sur disque (suite blob-store.contract.ts). */
export class MemoryBlobs implements BlobStore, BlobWriter {
  readonly #blobs = new Map<string, Uint8Array>();

  async has(sha256: string): Promise<boolean> {
    return this.#blobs.has(assertSha256(sha256));
  }

  async *read(sha256: string): AsyncIterable<Uint8Array> {
    const content = this.#blobs.get(assertSha256(sha256));
    if (!content) throw new LockmasterError('BLOB_NOT_FOUND', 'blob absent');
    yield content;
  }

  async write(source: AsyncIterable<Uint8Array>, options: BlobWriteOptions): Promise<StoredBlob> {
    assertMaxBytes(options.maxBytes);
    if (options.expectedSha256 !== undefined) assertSha256(options.expectedSha256);
    const aborted = () => new LockmasterError('BLOB_ABORTED', 'écriture annulée');
    if (options.signal?.aborted) throw aborted();
    const accumulator = new DigestAccumulator();
    const parts: Uint8Array[] = [];
    for await (const chunk of source) {
      if (options.signal?.aborted) throw aborted();
      if (accumulator.size + chunk.length > options.maxBytes) {
        throw new LockmasterError('BLOB_TOO_LARGE', 'blob trop gros');
      }
      accumulator.update(chunk);
      parts.push(Uint8Array.from(chunk));
    }
    if (accumulator.size === 0) throw new LockmasterError('BLOB_EMPTY', 'blob vide');
    const digests = { ...accumulator.finish(), size: accumulator.size };
    if (options.expectedSha256 !== undefined && options.expectedSha256 !== digests.sha256) {
      throw new LockmasterError('BLOB_HASH_MISMATCH', 'sha256 différent de celui annoncé');
    }
    const created = !this.#blobs.has(digests.sha256);
    if (created) this.#blobs.set(digests.sha256, new Uint8Array(Buffer.concat(parts)));
    return { ...digests, created };
  }
}
