import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../../src/formats/common/source.js';

/** Contenu de test : octets distincts pour repérer tout décalage. */
const CONTENT = Uint8Array.from({ length: 200_000 }, (_, index) => (index * 7 + 3) % 251);

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return new Uint8Array(Buffer.concat(parts));
}

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? 'erreur sans code';
  }
}

/** Suite de conformité de `ByteSource` : toute implémentation (mémoire, fichier...) la passe. */
export function describeByteSourceContract(make: (content: Uint8Array) => ByteSource): void {
  describe('contrat ByteSource', () => {
    it('annonce la taille exacte du contenu', () => {
      expect(make(CONTENT).size).toBe(CONTENT.length);
      expect(make(new Uint8Array(0)).size).toBe(0);
    });

    it('lit exactement la plage demandée, y compris vide ou en fin de contenu', async () => {
      const source = make(CONTENT);
      expect(await source.read(0, 16)).toEqual(CONTENT.subarray(0, 16));
      expect(await source.read(123_456, 1000)).toEqual(CONTENT.subarray(123_456, 124_456));
      expect(await source.read(CONTENT.length - 5, 5)).toEqual(CONTENT.subarray(CONTENT.length - 5));
      expect(await source.read(CONTENT.length, 0)).toEqual(new Uint8Array(0));
    });

    it('diffuse une plage en morceaux dont la concaténation est la plage', async () => {
      const source = make(CONTENT);
      expect(await collect(source.stream(0, CONTENT.length))).toEqual(CONTENT);
      expect(await collect(source.stream(70_000, 100_001))).toEqual(CONTENT.subarray(70_000, 170_001));
      expect(await collect(source.stream(10, 0))).toEqual(new Uint8Array(0));
    });

    it('refuse une plage qui dépasse la fin (FORMAT_TRUNCATED)', async () => {
      const source = make(CONTENT);
      expect(await codeOf(() => source.read(CONTENT.length - 1, 2))).toBe('FORMAT_TRUNCATED');
      expect(await codeOf(() => collect(source.stream(CONTENT.length, 1)))).toBe('FORMAT_TRUNCATED');
    });

    it('refuse une position ou une longueur négative ou non entière (FORMAT_INVALID)', async () => {
      const source = make(CONTENT);
      expect(await codeOf(() => source.read(-1, 1))).toBe('FORMAT_INVALID');
      expect(await codeOf(() => source.read(0, 1.5))).toBe('FORMAT_INVALID');
      expect(await codeOf(() => collect(source.stream(Number.NaN, 1)))).toBe('FORMAT_INVALID');
    });

    it("s'arrête quand le signal est déjà annulé (FORMAT_ABORTED)", async () => {
      const source = make(CONTENT);
      const signal = AbortSignal.abort();
      expect(await codeOf(() => source.read(0, 1, signal))).toBe('FORMAT_ABORTED');
      expect(await codeOf(() => collect(source.stream(0, CONTENT.length, signal)))).toBe('FORMAT_ABORTED');
    });

    it('renvoie des octets que le contenu ne partage pas avec un appel suivant', async () => {
      const source = make(CONTENT);
      const first = await source.read(0, 4);
      first.fill(0);
      expect(await source.read(0, 4)).toEqual(CONTENT.subarray(0, 4));
    });
  });
}
