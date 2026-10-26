import { randomBytes } from 'node:crypto';
import { constants, createZstdCompress, gzipSync, zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { asCompression, decompress, decompressToBuffer } from '../../../../src/formats/common/decompress.js';
import { FormatError } from '../../../../src/formats/common/errors.js';
import { DEFAULT_LIMITS } from '../../../../src/formats/common/limits.js';
import { corpusFile } from './corpus.js';

const MiB = 1024 * 1024;

async function* chunked(bytes: Uint8Array, size = 4096): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

async function* failing(): AsyncGenerator<Uint8Array> {
  yield gzipSync(Buffer.from('début')).subarray(0, 8);
  throw new FormatError('FORMAT_TRUNCATED', 'source tronquée');
}

const options = { maxOutputBytes: 8 * MiB, limits: DEFAULT_LIMITS };

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? `erreur sans code : ${String(error)}`;
  }
}

function zstdWithWindowLog(windowLog: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const encoder = createZstdCompress({ params: { [constants.ZSTD_c_windowLog]: windowLog } });
    const parts: Buffer[] = [];
    encoder.on('data', (chunk: Buffer) => parts.push(chunk));
    encoder.on('end', () => resolve(Buffer.concat(parts)));
    encoder.on('error', reject);
    encoder.end(Buffer.alloc(1000, 1));
  });
}

describe('decompress', () => {
  const payload = randomBytes(300_000);

  it.each([
    ['none', payload],
    ['gzip', gzipSync(payload)],
    ['gzip', Buffer.concat([gzipSync(payload.subarray(0, 1000)), gzipSync(payload.subarray(1000))])],
    ['zstd', zstdCompressSync(payload)],
  ] as const)('restitue les données (%s)', async (compression, input) => {
    expect(await decompressToBuffer(chunked(input), compression, options)).toEqual(payload);
  });

  it('diffuse la sortie en plusieurs morceaux', async () => {
    let chunks = 0;
    for await (const _chunk of decompress(chunked(gzipSync(payload)), 'gzip', options)) chunks += 1;
    expect(chunks).toBeGreaterThan(1);
  });

  it.each(['none', 'gzip', 'zstd'] as const)('borne la sortie : bombe de zéros refusée (%s)', async (compression) => {
    const zeros = Buffer.alloc(3 * MiB);
    const input = compression === 'gzip' ? gzipSync(zeros) : compression === 'zstd' ? zstdCompressSync(zeros) : zeros;
    const code = await codeOf(() =>
      decompressToBuffer(chunked(input), compression, { ...options, maxOutputBytes: MiB }),
    );
    expect(code).toBe('FORMAT_LIMIT_EXCEEDED');
  });

  it('refuse un flux zstd dont la fenêtre dépasse 2^27 (SEC-22)', async () => {
    expect(await decompressToBuffer(chunked(await zstdWithWindowLog(27)), 'zstd', options)).toHaveLength(1000);
    const code = await codeOf(async () => decompressToBuffer(chunked(await zstdWithWindowLog(28)), 'zstd', options));
    expect(code).toBe('FORMAT_LIMIT_EXCEEDED');
  });

  it.each([
    ['gzip tronqué', 'gzip', gzipSync(payload).subarray(0, 5000)],
    ['gzip vide', 'gzip', Buffer.alloc(0)],
    ['gzip suivi de déchets', 'gzip', Buffer.concat([gzipSync(payload), Buffer.from('déchets')])],
    ['gzip au CRC faux', 'gzip', corruptTrailer(gzipSync(payload))],
    ['pas du gzip', 'gzip', Buffer.from('ceci est du texte')],
    ['zstd tronqué', 'zstd', zstdCompressSync(payload).subarray(0, 5000)],
    ['pas du zstd', 'zstd', Buffer.from('ceci est du texte')],
  ] as const)('rejette : %s (FORMAT_CORRUPT_STREAM)', async (_label, compression, input) => {
    expect(await codeOf(() => decompressToBuffer(chunked(input), compression, options))).toBe('FORMAT_CORRUPT_STREAM');
  });

  it("propage telle quelle l'erreur typée de la source", async () => {
    expect(await codeOf(() => decompressToBuffer(failing(), 'gzip', options))).toBe('FORMAT_TRUNCATED');
  });

  it("s'arrête sur un signal annulé (FORMAT_ABORTED)", async () => {
    const signal = AbortSignal.abort();
    const code = await codeOf(() => decompressToBuffer(chunked(gzipSync(payload)), 'gzip', { ...options, signal }));
    expect(code).toBe('FORMAT_ABORTED');
  });
});

describe('asCompression', () => {
  it('reconnaît les algorithmes pris en charge', () => {
    expect(asCompression('gzip')).toBe('gzip');
    expect(asCompression('zstd')).toBe('zstd');
    expect(asCompression('none')).toBe('none');
  });

  it.each(['lzma', 'lz4', 'GZIP', '', 'constructor'])('refuse « %s » (FORMAT_UNSUPPORTED_COMPRESSION)', (name) => {
    expect(() => asCompression(name)).toThrowError(expect.objectContaining({ code: 'FORMAT_UNSUPPORTED_COMPRESSION' }));
  });
});

function corruptTrailer(gzip: Buffer): Buffer {
  const copy = Buffer.from(gzip);
  const crcOffset = copy.length - 8;
  copy[crcOffset] = (copy[crcOffset] ?? 0) ^ 0xff;
  return copy;
}

describe('decompress avec un signal actif', () => {
  it.each([
    ['zstd', zstdCompressSync(Buffer.from('signal actif'))],
    ['xz', corpusFile('xz/empty.xz')],
    ['bzip2', corpusFile('bzip2/empty.bz2')],
  ] as const)("%s décode normalement tant que le signal n'est pas déclenché", async (compression, input) => {
    const { signal } = new AbortController();
    const output = await decompressToBuffer(chunked(input), compression, { ...options, signal });
    expect(output.length).toBeLessThanOrEqual(12);
  });
});
