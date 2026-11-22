import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, link, lstat, mkdir, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LockmasterError } from '../domain/errors.js';
import type { RandomSource } from '../domain/ports.js';
import { DigestAccumulator } from '../formats/common/digests.js';
import { assertMaxBytes } from './limits.js';
import { assertSha256, blobRelativePath } from './paths.js';
import type { BlobDigests, BlobStore, BlobWriteOptions, BlobWriter, StoredBlob } from './types.js';

// Blobs sur disque (ADR-0002, docs/04 §2.1) : écriture dans tmp/ (O_EXCL, empreintes calculées à la
// volée, fsync), puis lien dur vers blobs/sha256/ab/cd/<sha256>. link() échoue si la cible existe,
// donc un blob n'est jamais remplacé, même en cas d'écritures concurrentes du même contenu. Le fichier
// est rendu immuable (0440) avant d'être visible. tmp/ et blobs/ sont sur le même système de fichiers
// (sous data_dir).

export interface FsBlobsOptions {
  blobsDir: string;
  tmpDir: string;
  random: RandomSource;
}

const DIR_MODE = 0o750;
const BLOB_MODE = 0o440;

const aborted = () => new LockmasterError('BLOB_ABORTED', 'écriture ou lecture de blob annulée');
const errnoOf = (error: unknown) => (error as NodeJS.ErrnoException).code;

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
}

async function fsyncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class FsBlobs implements BlobStore, BlobWriter {
  readonly #options: FsBlobsOptions;

  constructor(options: FsBlobsOptions) {
    this.#options = options;
  }

  #path(sha256: string): string {
    return join(this.#options.blobsDir, blobRelativePath(sha256));
  }

  async has(sha256: string): Promise<boolean> {
    try {
      return (await lstat(this.#path(sha256))).isFile();
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return false;
      throw error;
    }
  }

  async *read(sha256: string, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    let handle: FileHandle;
    try {
      handle = await open(this.#path(sha256), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (['ENOENT', 'ELOOP'].includes(errnoOf(error) ?? '')) {
        throw new LockmasterError('BLOB_NOT_FOUND', `blob ${sha256} absent`);
      }
      throw error;
    }
    // Le contenu est revérifié pendant la lecture : un blob altéré sur disque lève BLOB_CORRUPT en fin
    // de flux. Le consommateur ne retient donc son résultat (scan, envoi) qu'après un flux complet.
    const hash = createHash('sha256');
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        if (signal?.aborted) throw aborted();
        hash.update(chunk as Buffer);
        yield chunk as Buffer;
      }
    } finally {
      await handle.close();
    }
    if (hash.digest('hex') !== sha256) {
      throw new LockmasterError('BLOB_CORRUPT', `blob ${sha256} : contenu altéré sur disque`);
    }
  }

  async write(source: AsyncIterable<Uint8Array>, options: BlobWriteOptions): Promise<StoredBlob> {
    assertMaxBytes(options.maxBytes);
    if (options.expectedSha256 !== undefined) assertSha256(options.expectedSha256);
    if (options.signal?.aborted) throw aborted();
    await mkdir(this.#options.tmpDir, { recursive: true, mode: DIR_MODE });
    const tmp = join(this.#options.tmpDir, `${Buffer.from(this.#options.random.bytes(16)).toString('hex')}.part`);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    const handle = await open(tmp, flags, 0o600);
    try {
      let digests: BlobDigests;
      try {
        digests = await this.#copy(source, handle, options);
        await handle.chmod(BLOB_MODE);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return await this.#install(tmp, digests);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async #copy(source: AsyncIterable<Uint8Array>, handle: FileHandle, options: BlobWriteOptions): Promise<BlobDigests> {
    const accumulator = new DigestAccumulator();
    for await (const chunk of source) {
      if (options.signal?.aborted) throw aborted();
      if (accumulator.size + chunk.length > options.maxBytes) {
        throw new LockmasterError('BLOB_TOO_LARGE', `blob de plus de ${options.maxBytes} octets`);
      }
      accumulator.update(chunk);
      await writeAll(handle, chunk);
    }
    if (options.signal?.aborted) throw aborted();
    if (accumulator.size === 0) throw new LockmasterError('BLOB_EMPTY', 'blob vide');
    const digests = { ...accumulator.finish(), size: accumulator.size };
    if (options.expectedSha256 !== undefined && options.expectedSha256 !== digests.sha256) {
      throw new LockmasterError('BLOB_HASH_MISMATCH', `sha256 ${digests.sha256} différent de celui annoncé`);
    }
    return digests;
  }

  async #install(tmp: string, digests: BlobDigests): Promise<StoredBlob> {
    const path = this.#path(digests.sha256);
    await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
    try {
      await link(tmp, path);
    } catch (error) {
      if (errnoOf(error) !== 'EEXIST') throw error;
      const existing = await lstat(path);
      if (!existing.isFile() || existing.size !== digests.size) {
        throw new LockmasterError(
          'BLOB_CONFLICT',
          `blob ${digests.sha256} : fichier existant non conforme, non remplacé`,
        );
      }
      return { ...digests, created: false };
    }
    await fsyncDirectory(dirname(path));
    return { ...digests, created: true };
  }
}
