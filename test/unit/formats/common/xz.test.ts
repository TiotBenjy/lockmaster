import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decompressToBuffer } from '../../../../src/formats/common/decompress.js';
import { DEFAULT_LIMITS, type FormatLimits } from '../../../../src/formats/common/limits.js';
import { PAYLOADS } from '../../../fixtures/builders/payloads.js';
import { chunked, corpusEntries, corpusFile, expectedOutput } from './corpus.js';

const MiB = 1024 * 1024;
const OPTIONS = { maxOutputBytes: 16 * MiB, limits: DEFAULT_LIMITS };

async function decode(bytes: Uint8Array, options: Partial<typeof OPTIONS> = {}, chunkSize = 4096): Promise<Buffer> {
  return decompressToBuffer(chunked(bytes, chunkSize), 'xz', { ...OPTIONS, ...options });
}

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? `erreur sans code : ${String(error)}`;
  }
}

const TEXT = corpusFile('xz/text-crc64.xz');

describe('décodeur xz (corpus produit par XZ Utils)', () => {
  for (const entry of corpusEntries('xz')) {
    it(`${entry.file} : ${entry.expect} (${entry.command})`, async () => {
      if (entry.expect === 'ok') {
        expect((await decode(corpusFile(entry.file))).equals(expectedOutput(entry))).toBe(true);
      } else {
        expect(await codeOf(() => decode(corpusFile(entry.file)))).toBe(entry.expect);
      }
    });
  }

  it("ne dépend pas du découpage de l'entrée (morceaux de 1, 7 et 65 537 octets)", async () => {
    expect((await decode(corpusFile('xz/empty.xz'), {}, 1)).length).toBe(0);
    expect((await decode(corpusFile('xz/text-crc32.xz'), {}, 7)).equals(Buffer.from(PAYLOADS.text()))).toBe(true);
    expect((await decode(corpusFile('xz/mixed-1.xz'), {}, 65_537)).length).toBe(200 * 1024);
  });
});

describe('décodeur xz : données corrompues', () => {
  it.each([12, 13, 20, 100, 5000, TEXT.length - 40, TEXT.length - 20, TEXT.length - 10, TEXT.length - 3])(
    'un octet modifié à la position %i est détecté (FORMAT_CORRUPT_STREAM)',
    async (position) => {
      const copy = Buffer.from(TEXT);
      copy[position] = (copy[position] ?? 0) ^ 0x55;
      expect(await codeOf(() => decode(copy))).toBe('FORMAT_CORRUPT_STREAM');
    },
  );

  it.each([0, 1, 11, 12, 30, 10_000, TEXT.length - 13, TEXT.length - 1])(
    'un flux tronqué à %i octets est refusé (FORMAT_CORRUPT_STREAM)',
    async (length) => {
      expect(await codeOf(() => decode(TEXT.subarray(0, length)))).toBe('FORMAT_CORRUPT_STREAM');
    },
  );

  it('refuse des déchets après le flux et un remplissage non multiple de 4', async () => {
    expect(await codeOf(() => decode(Buffer.concat([TEXT, Buffer.from('déchets')])))).toBe('FORMAT_CORRUPT_STREAM');
    expect(await codeOf(() => decode(Buffer.concat([TEXT, Buffer.alloc(3)])))).toBe('FORMAT_CORRUPT_STREAM');
    expect((await decode(Buffer.concat([TEXT, Buffer.alloc(8)]))).length).toBe(200 * 1024);
  });

  it('refuse un type de contrôle inconnu ou des bits réservés (FORMAT_UNSUPPORTED_COMPRESSION)', async () => {
    expect(await codeOf(() => decode(withCheckId(TEXT, 2)))).toBe('FORMAT_UNSUPPORTED_COMPRESSION');
    expect(await codeOf(() => decode(withCheckId(TEXT, 16)))).toBe('FORMAT_UNSUPPORTED_COMPRESSION');
  });
});

describe('décodeur xz : limites (SEC-22)', () => {
  it('refuse une sortie au-delà du budget sans la produire (FORMAT_LIMIT_EXCEEDED)', async () => {
    const zeros = corpusFile('xz/zeros.xz');
    expect(await codeOf(() => decode(zeros, { maxOutputBytes: 2 * MiB }))).toBe('FORMAT_LIMIT_EXCEEDED');
    expect((await decode(zeros, { maxOutputBytes: 3 * MiB })).length).toBe(3 * MiB);
  });

  it('décode avec un dictionnaire plus petit que celui déclaré tant que les distances y tiennent', async () => {
    const limits: FormatLimits = { ...DEFAULT_LIMITS, xzMaxDictionaryBytes: 64 * 1024 };
    expect((await decode(corpusFile('xz/zeros.xz'), { limits })).length).toBe(3 * MiB);
  });

  it('refuse une distance au-delà du dictionnaire autorisé (FORMAT_LIMIT_EXCEEDED)', async () => {
    const limits: FormatLimits = { ...DEFAULT_LIMITS, xzMaxDictionaryBytes: 64 * 1024 };
    const longrange = corpusFile('xz/longrange.xz');
    expect(await codeOf(() => decode(longrange, { limits }))).toBe('FORMAT_LIMIT_EXCEEDED');
  });

  it("s'arrête sur un signal annulé (FORMAT_ABORTED)", async () => {
    const signal = AbortSignal.abort();
    expect(await codeOf(() => decompressToBuffer(chunked(TEXT), 'xz', { ...OPTIONS, signal }))).toBe('FORMAT_ABORTED');
  });
});

/** Remplace l'identifiant de contrôle de l'en-tête de flux et recalcule son CRC32. */
function withCheckId(stream: Buffer, checkId: number): Buffer {
  const copy = Buffer.from(stream);
  copy[7] = checkId;
  copy.writeUInt32LE(crc32(copy.subarray(6, 8)), 8);
  return copy;
}
