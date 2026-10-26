import { describe, expect, it } from 'vitest';
import { decompressToBuffer } from '../../../../src/formats/common/decompress.js';
import { DEFAULT_LIMITS } from '../../../../src/formats/common/limits.js';
import { PAYLOADS } from '../../../fixtures/builders/payloads.js';
import { chunked, corpusEntries, corpusFile, expectedOutput } from './corpus.js';

const MiB = 1024 * 1024;
const OPTIONS = { maxOutputBytes: 16 * MiB, limits: DEFAULT_LIMITS };

async function decode(bytes: Uint8Array, options: Partial<typeof OPTIONS> = {}, chunkSize = 4096): Promise<Buffer> {
  return decompressToBuffer(chunked(bytes, chunkSize), 'bzip2', { ...OPTIONS, ...options });
}

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? `erreur sans code : ${String(error)}`;
  }
}

const TEXT = corpusFile('bzip2/text-9.bz2');

describe('décodeur bzip2 (corpus produit par bzip2 1.0.8)', () => {
  for (const entry of corpusEntries('bzip2')) {
    it(`${entry.file} : ${entry.expect} (${entry.command})`, async () => {
      expect((await decode(corpusFile(entry.file))).equals(expectedOutput(entry))).toBe(true);
    });
  }

  it("ne dépend pas du découpage de l'entrée", async () => {
    expect((await decode(corpusFile('bzip2/empty.bz2'), {}, 1)).length).toBe(0);
    expect((await decode(TEXT, {}, 7)).equals(Buffer.from(PAYLOADS.text()))).toBe(true);
  });
});

describe('décodeur bzip2 : données corrompues', () => {
  it.each([0, 3, 4, 10, 40, 1000, 8000, TEXT.length - 8, TEXT.length - 2])(
    'un octet modifié à la position %i est détecté (FORMAT_CORRUPT_STREAM)',
    async (position) => {
      const copy = Buffer.from(TEXT);
      copy[position] = (copy[position] ?? 0) ^ 0x24;
      expect(await codeOf(() => decode(copy))).toBe('FORMAT_CORRUPT_STREAM');
    },
  );

  it.each([0, 3, 4, 20, 9000, TEXT.length - 5, TEXT.length - 1])(
    'un flux tronqué à %i octets est refusé (FORMAT_CORRUPT_STREAM)',
    async (length) => {
      expect(await codeOf(() => decode(TEXT.subarray(0, length)))).toBe('FORMAT_CORRUPT_STREAM');
    },
  );

  it('refuse des déchets après le flux et un niveau de bloc invalide', async () => {
    expect(await codeOf(() => decode(Buffer.concat([TEXT, Buffer.from('déchets')])))).toBe('FORMAT_CORRUPT_STREAM');
    expect(await codeOf(() => decode(Buffer.concat([TEXT, Buffer.alloc(1)])))).toBe('FORMAT_CORRUPT_STREAM');
    const level0 = Buffer.from(TEXT);
    level0[3] = 0x30;
    expect(await codeOf(() => decode(level0))).toBe('FORMAT_CORRUPT_STREAM');
  });

  it('refuse un bloc « randomisé » (format obsolète, FORMAT_UNSUPPORTED_COMPRESSION)', async () => {
    const copy = Buffer.from(TEXT);
    // Bit « randomised » : premier bit après l'en-tête (4 o), la magie de bloc (6 o) et le CRC (4 o).
    copy[14] = (copy[14] ?? 0) | 0x80;
    expect(await codeOf(() => decode(copy))).toBe('FORMAT_UNSUPPORTED_COMPRESSION');
  });
});

describe('décodeur bzip2 : limites', () => {
  it('refuse une avalanche de flux vides concaténés (amplification CPU, FORMAT_LIMIT_EXCEEDED)', async () => {
    const empty = corpusFile('bzip2/empty.bz2');
    const many = Buffer.concat(Array.from({ length: 10_000 }, () => empty));
    const started = performance.now();
    expect(await codeOf(() => decode(many))).toBe('FORMAT_LIMIT_EXCEEDED');
    expect(performance.now() - started).toBeLessThan(2000);
    expect((await decode(Buffer.concat([empty, empty]))).length).toBe(0);
  });

  it('refuse une sortie au-delà du budget (FORMAT_LIMIT_EXCEEDED)', async () => {
    const zeros = corpusFile('bzip2/zeros.bz2');
    expect(await codeOf(() => decode(zeros, { maxOutputBytes: 2 * MiB }))).toBe('FORMAT_LIMIT_EXCEEDED');
    expect((await decode(zeros, { maxOutputBytes: 3 * MiB })).length).toBe(3 * MiB);
  });

  it("s'arrête sur un signal annulé (FORMAT_ABORTED)", async () => {
    const signal = AbortSignal.abort();
    const code = await codeOf(() => decompressToBuffer(chunked(TEXT), 'bzip2', { ...OPTIONS, signal }));
    expect(code).toBe('FORMAT_ABORTED');
  });
});
