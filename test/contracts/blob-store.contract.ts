import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { BlobStore, BlobWriter } from '../../src/storage/types.js';
import { expectSameBytes } from '../helpers/bytes.js';

export interface BlobStorage {
  store: BlobStore;
  writer: BlobWriter;
}

const CONTENT = Uint8Array.from({ length: 300_000 }, (_, index) => (index * 13 + 5) % 251);
const LIMIT = { maxBytes: 1024 * 1024 };

async function* chunksOf(data: Uint8Array, size = 65_536): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < data.length; offset += size) yield data.subarray(offset, offset + size);
}

async function* failingAfterFirstChunk(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data.subarray(0, 1000);
  throw new Error('source interrompue');
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return new Uint8Array(Buffer.concat(parts));
}

const digest = (algorithm: string, data: Uint8Array) => createHash(algorithm).update(data).digest('hex');

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? `erreur sans code : ${(error as Error).message}`;
  }
}

/** Suite de conformité de `BlobStore` et `BlobWriter` : stockage sur disque et faux en mémoire. */
export function describeBlobStoreContract(make: () => BlobStorage): void {
  describe('contrat BlobStore / BlobWriter', () => {
    it("stocke le contenu, rend ses empreintes et le relit à l'identique", async () => {
      const { store, writer } = make();
      const stored = await writer.write(chunksOf(CONTENT), LIMIT);
      expect(stored).toEqual({
        sha256: digest('sha256', CONTENT),
        sha512: digest('sha512', CONTENT),
        sha1: digest('sha1', CONTENT),
        md5: digest('md5', CONTENT),
        size: CONTENT.length,
        created: true,
      });
      expect(await store.has(stored.sha256)).toBe(true);
      expectSameBytes(await collect(store.read(stored.sha256)), CONTENT);
    });

    it("déduplique : un contenu déjà stocké n'est pas réécrit", async () => {
      const { store, writer } = make();
      const first = await writer.write(chunksOf(CONTENT), LIMIT);
      const second = await writer.write(chunksOf(CONTENT, 7_000), LIMIT);
      expect(second).toEqual({ ...first, created: false });
      expectSameBytes(await collect(store.read(first.sha256)), CONTENT);
    });

    it('accepte exactement maxBytes, refuse un octet de plus sans rien conserver', async () => {
      const { store, writer } = make();
      expect((await writer.write(chunksOf(CONTENT), { maxBytes: CONTENT.length })).size).toBe(CONTENT.length);
      const larger = new Uint8Array([...CONTENT.subarray(0, 1000), 1]);
      expect(await codeOf(() => writer.write(chunksOf(larger), { maxBytes: 1000 }))).toBe('BLOB_TOO_LARGE');
      expect(await store.has(digest('sha256', larger))).toBe(false);
    });

    it('refuse un contenu vide', async () => {
      const { writer } = make();
      expect(await codeOf(() => writer.write(chunksOf(new Uint8Array(0)), LIMIT))).toBe('BLOB_EMPTY');
    });

    it("vérifie le sha256 annoncé et ne conserve rien s'il diffère", async () => {
      const { store, writer } = make();
      const expectedSha256 = digest('sha256', CONTENT);
      expect((await writer.write(chunksOf(CONTENT), { ...LIMIT, expectedSha256 })).sha256).toBe(expectedSha256);

      const other = CONTENT.subarray(0, 5000);
      const code = await codeOf(() => writer.write(chunksOf(other), { ...LIMIT, expectedSha256 }));
      expect(code).toBe('BLOB_HASH_MISMATCH');
      expect(await store.has(digest('sha256', other))).toBe(false);
    });

    it('refuse un sha256 annoncé mal formé avant toute écriture', async () => {
      const { writer } = make();
      const expectedSha256 = digest('sha256', CONTENT).toUpperCase();
      expect(await codeOf(() => writer.write(chunksOf(CONTENT), { ...LIMIT, expectedSha256 }))).toBe('BLOB_INVALID_ID');
    });

    it("s'arrête sur un signal d'annulation sans rien conserver", async () => {
      const { store, writer } = make();
      const controller = new AbortController();
      controller.abort();
      const code = await codeOf(() => writer.write(chunksOf(CONTENT), { ...LIMIT, signal: controller.signal }));
      expect(code).toBe('BLOB_ABORTED');
      expect(await store.has(digest('sha256', CONTENT))).toBe(false);
    });

    it("s'arrête sur une annulation reçue en cours d'écriture sans rien conserver", async () => {
      const { store, writer } = make();
      const controller = new AbortController();
      async function* abortingAfterFirstChunk(): AsyncIterable<Uint8Array> {
        yield CONTENT.subarray(0, 1000);
        controller.abort();
        yield CONTENT.subarray(1000, 2000);
      }
      const code = await codeOf(() => writer.write(abortingAfterFirstChunk(), { ...LIMIT, signal: controller.signal }));
      expect(code).toBe('BLOB_ABORTED');
      expect(await store.has(digest('sha256', CONTENT.subarray(0, 2000)))).toBe(false);
    });

    it('refuse une limite de taille invalide avant toute écriture', async () => {
      const { writer } = make();
      for (const maxBytes of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, 1.5]) {
        expect(await codeOf(() => writer.write(chunksOf(CONTENT), { maxBytes })), String(maxBytes)).toBe(
          'BLOB_INVALID_LIMIT',
        );
      }
    });

    it('deux écritures simultanées du même contenu : un seul blob créé, contenu intact', async () => {
      const { store, writer } = make();
      const results = await Promise.all([
        writer.write(chunksOf(CONTENT), LIMIT),
        writer.write(chunksOf(CONTENT, 10_000), LIMIT),
        writer.write(chunksOf(CONTENT, 3_000), LIMIT),
      ]);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expectSameBytes(await collect(store.read(digest('sha256', CONTENT))), CONTENT);
    });

    it("propage l'échec de la source sans rien conserver", async () => {
      const { store, writer } = make();
      await expect(writer.write(failingAfterFirstChunk(CONTENT), LIMIT)).rejects.toThrow('source interrompue');
      expect(await store.has(digest('sha256', CONTENT.subarray(0, 1000)))).toBe(false);
    });

    it('signale un blob absent et refuse un identifiant mal formé', async () => {
      const { store } = make();
      const absent = digest('sha256', new Uint8Array([42]));
      expect(await store.has(absent)).toBe(false);
      expect(await codeOf(() => collect(store.read(absent)))).toBe('BLOB_NOT_FOUND');
      for (const id of [absent.toUpperCase(), `../${absent.slice(3)}`, absent.slice(1), `${absent}0`, '']) {
        expect(await codeOf(() => store.has(id)), id).toBe('BLOB_INVALID_ID');
        expect(await codeOf(() => collect(store.read(id))), id).toBe('BLOB_INVALID_ID');
      }
    });
  });
}
