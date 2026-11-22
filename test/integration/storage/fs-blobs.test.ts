import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsBlobs } from '../../../src/storage/fs-blobs.js';
import { describeBlobStoreContract } from '../../contracts/blob-store.contract.js';
import { FakeRandom } from '../../fakes/random.js';
import { makeTree } from '../../helpers/run-script.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function storage() {
  const { root, cleanup } = makeTree({ 'data/keep': '' });
  cleanups.push(cleanup);
  const blobsDir = join(root, 'data/blobs');
  const tmpDir = join(root, 'data/tmp');
  const blobs = new FsBlobs({ blobsDir, tmpDir, random: new FakeRandom('blobs') });
  return { root, blobsDir, tmpDir, blobs };
}

async function* once(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

const CONTENT = new TextEncoder().encode('contenu de paquet\n'.repeat(1000));
const SHA = createHash('sha256').update(CONTENT).digest('hex');
const finalPath = (blobsDir: string) => join(blobsDir, 'sha256', SHA.slice(0, 2), SHA.slice(2, 4), SHA);

describeBlobStoreContract(() => {
  const { blobs } = storage();
  return { store: blobs, writer: blobs };
});

describe('FsBlobs : stockage sur disque', () => {
  it('range le blob sous sha256/ab/cd/<sha256>, en lecture seule (0440), dossiers en 0750', async () => {
    const { blobsDir, blobs } = storage();
    await blobs.write(once(CONTENT), { maxBytes: 1 << 20 });
    const path = finalPath(blobsDir);
    expect(readFileSync(path)).toEqual(Buffer.from(CONTENT));
    expect(statSync(path).mode & 0o777).toBe(0o440);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o750);
    expect(statSync(join(blobsDir, 'sha256')).mode & 0o777).toBe(0o750);
  });

  it('ne laisse aucun fichier temporaire, après un succès comme après un échec', async () => {
    const { tmpDir, blobs } = storage();
    await blobs.write(once(CONTENT), { maxBytes: 1 << 20 });
    await blobs.write(once(CONTENT), { maxBytes: 1 << 20 });
    await expect(blobs.write(once(CONTENT), { maxBytes: 10 })).rejects.toMatchObject({ code: 'BLOB_TOO_LARGE' });
    const expectedSha256 = 'f'.repeat(64);
    await expect(blobs.write(once(CONTENT), { maxBytes: 1 << 20, expectedSha256 })).rejects.toMatchObject({
      code: 'BLOB_HASH_MISMATCH',
    });
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it("ne laisse aucun fichier temporaire après un échec de la source ou une annulation en cours d'écriture", async () => {
    const { tmpDir, blobs } = storage();
    async function* failing(): AsyncIterable<Uint8Array> {
      yield CONTENT.subarray(0, 100);
      throw new Error('source interrompue');
    }
    await expect(blobs.write(failing(), { maxBytes: 1 << 20 })).rejects.toThrow('source interrompue');
    const controller = new AbortController();
    async function* aborting(): AsyncIterable<Uint8Array> {
      yield CONTENT.subarray(0, 100);
      controller.abort();
      yield CONTENT.subarray(100, 200);
    }
    await expect(blobs.write(aborting(), { maxBytes: 1 << 20, signal: controller.signal })).rejects.toMatchObject({
      code: 'BLOB_ABORTED',
    });
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('détecte à la lecture un blob altéré à taille égale (BLOB_CORRUPT en fin de flux)', async () => {
    const { blobsDir, blobs } = storage();
    await blobs.write(once(CONTENT), { maxBytes: 1 << 20 });
    const path = finalPath(blobsDir);
    const altered = Buffer.from(CONTENT);
    altered[500] = (altered[500] ?? 0) ^ 1;
    chmodSync(path, 0o640);
    writeFileSync(path, altered);
    // La déduplication ne relit pas le contenu (taille égale) ; la lecture, elle, le vérifie.
    expect((await blobs.write(once(CONTENT), { maxBytes: 1 << 20 })).created).toBe(false);
    const read = async () => {
      for await (const _chunk of blobs.read(SHA)) {
        // lecture complète
      }
    };
    await expect(read()).rejects.toMatchObject({ code: 'BLOB_CORRUPT' });
  });

  it('ne remplace jamais un fichier existant ; une taille différente est signalée comme conflit', async () => {
    const { blobsDir, blobs } = storage();
    const path = finalPath(blobsDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'contenu altéré');
    chmodSync(path, 0o440);
    await expect(blobs.write(once(CONTENT), { maxBytes: 1 << 20 })).rejects.toMatchObject({ code: 'BLOB_CONFLICT' });
    expect(readFileSync(path, 'utf8')).toBe('contenu altéré');
  });

  it("ne suit pas un lien symbolique posé à l'emplacement du blob", async () => {
    const { root, blobsDir, blobs } = storage();
    const path = finalPath(blobsDir);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(join(root, 'ailleurs'), path);
    await expect(blobs.write(once(CONTENT), { maxBytes: 1 << 20 })).rejects.toMatchObject({ code: 'BLOB_CONFLICT' });
    expect(existsSync(join(root, 'ailleurs'))).toBe(false);
    await expect(blobs.has(SHA)).resolves.toBe(false);
  });

  it("ne lit pas à travers un lien symbolique posé à l'emplacement du blob", async () => {
    const { root, blobsDir, blobs } = storage();
    const path = finalPath(blobsDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(join(root, 'cible'), CONTENT);
    symlinkSync(join(root, 'cible'), path);
    const read = async () => {
      for await (const _chunk of blobs.read(SHA)) {
        // lecture complète
      }
    };
    await expect(read()).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
  });
});
