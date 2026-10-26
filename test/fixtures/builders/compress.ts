// Compression des fixtures sans outil externe : gzip et zstd par node:zlib, xz par morceaux LZMA2 non
// compressés (flux .xz valide), bzip2 par l'encodeur de test (blocs de 4 Kio pour garder la BWT naïve
// rapide). « lzma » écrit un en-tête .lzma factice : le parseur doit le refuser avant de le lire.

import { gzipSync, zstdCompressSync } from 'node:zlib';
import { buildBzip2 } from './bzip2.js';
import { buildXz, lzma2Uncompressed } from './xz.js';

export type FixtureCompression = 'none' | 'gzip' | 'zstd' | 'xz' | 'bzip2' | 'lzma';

export const EXTENSIONS: Readonly<Record<FixtureCompression, string>> = {
  none: '',
  gzip: '.gz',
  zstd: '.zst',
  xz: '.xz',
  bzip2: '.bz2',
  lzma: '.lzma',
};

export function compress(bytes: Uint8Array, compression: FixtureCompression): Uint8Array {
  switch (compression) {
    case 'none':
      return bytes;
    case 'gzip':
      return gzipSync(bytes);
    case 'zstd':
      return zstdCompressSync(bytes);
    case 'xz':
      return buildXz({ blocks: [{ lzma2: lzma2Uncompressed(bytes), content: bytes }] });
    case 'bzip2': {
      const blocks = [];
      for (let offset = 0; offset < Math.max(bytes.length, 1); offset += 4096) {
        blocks.push({ content: bytes.subarray(offset, offset + 4096) });
      }
      return buildBzip2({ blocks: bytes.length === 0 ? [] : blocks });
    }
    case 'lzma':
      return Uint8Array.of(0x5d, 0x00, 0x00, 0x80, 0x00, ...bytes);
  }
}
