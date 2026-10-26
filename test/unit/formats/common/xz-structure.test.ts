// Chemins d'erreur structurels du décodeur xz, sur des flux forgés (CRC recalculés) : chaque champ
// invalide est refusé avec le bon code.
import { describe, expect, it } from 'vitest';
import { decompressToBuffer } from '../../../../src/formats/common/decompress.js';
import { DEFAULT_LIMITS } from '../../../../src/formats/common/limits.js';
import { PAYLOADS } from '../../../fixtures/builders/payloads.js';
import {
  buildXz,
  firstLzmaChunk,
  lzma2Uncompressed,
  lzmaChunkBytes,
  type XzBlockSpec,
  type XzStreamSpec,
} from '../../../fixtures/builders/xz.js';
import { chunked, corpusFile } from './corpus.js';

const OPTIONS = { maxOutputBytes: 8 * 1024 * 1024, limits: DEFAULT_LIMITS };
const CONTENT = Buffer.from('Lockmaster : contenu de test non compressé.\n'.repeat(40));
const BLOCK: XzBlockSpec = { lzma2: lzma2Uncompressed(CONTENT), content: CONTENT };

const decode = (bytes: Uint8Array): Promise<Buffer> => decompressToBuffer(chunked(bytes, 97), 'xz', OPTIONS);

async function codeOf(bytes: Uint8Array): Promise<string> {
  try {
    await decode(bytes);
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? `erreur sans code : ${String(error)}`;
  }
}

function withByte(bytes: Uint8Array, position: number, value: number): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[position] = value === copy[position] ? value ^ 0xff : value;
  return copy;
}

const stream = (spec: Partial<XzStreamSpec>, block: Partial<XzBlockSpec> = {}): Uint8Array =>
  buildXz({ blocks: [{ ...BLOCK, ...block }], ...spec });

describe('flux xz forgés valides', () => {
  it.each([0, 1, 4, 10])('décode des morceaux non compressés avec le contrôle %i', async (checkType) => {
    expect((await decode(stream({ checkType }))).equals(CONTENT)).toBe(true);
  });

  it('accepte des tailles stockées exactes et un flux sans bloc', async () => {
    expect((await decode(stream({}, { storeSizes: true }))).equals(CONTENT)).toBe(true);
    expect((await decode(buildXz({ blocks: [] }))).length).toBe(0);
  });

  it('gère un index de plus de 4 Kio (2 500 blocs) et plusieurs morceaux de 64 Kio', async () => {
    const tiny: XzBlockSpec = { lzma2: lzma2Uncompressed(Buffer.from('ab')), content: Buffer.from('ab') };
    expect((await decode(buildXz({ blocks: Array.from({ length: 2500 }, () => tiny) }))).length).toBe(5000);
    const big = Buffer.from(PAYLOADS.random().subarray(0, 70_000));
    expect((await decode(buildXz({ blocks: [{ lzma2: lzma2Uncompressed(big), content: big }] }))).equals(big)).toBe(
      true,
    );
  });
});

describe('en-têtes de flux et de bloc invalides', () => {
  it.each<[string, Uint8Array, string]>([
    ['drapeau de flux réservé', stream({ streamFlags: [0x01, 0x01] }), 'FORMAT_UNSUPPORTED_COMPRESSION'],
    ['taille compressée fausse', stream({}, { storeSizes: true, compressedSize: 10 }), 'FORMAT_CORRUPT_STREAM'],
    ['taille décompressée fausse', stream({}, { storeSizes: true, uncompressedSize: 5 }), 'FORMAT_CORRUPT_STREAM'],
    ['taille compressée nulle', stream({}, { storeSizes: true, compressedSize: 0 }), 'FORMAT_CORRUPT_STREAM'],
    ['filtre absent', stream({}, { filterBytes: [] }), 'FORMAT_CORRUPT_STREAM'],
    ['filtre Delta seul', stream({}, { filterBytes: [0x03, 0x01, 0x00] }), 'FORMAT_UNSUPPORTED_COMPRESSION'],
    ['propriétés de taille 2', stream({}, { filterBytes: [0x21, 0x02, 0x16, 0x00] }), 'FORMAT_UNSUPPORTED_COMPRESSION'],
    ['dictionnaire au-delà de 3 Gio', stream({}, { filterBytes: [0x21, 0x01, 40] }), 'FORMAT_UNSUPPORTED_COMPRESSION'],
    ['remplissage non nul', stream({}, { headerPadding: [0x00, 0x07] }), 'FORMAT_UNSUPPORTED_COMPRESSION'],
    [
      'entier non minimal',
      stream({}, { flags: 0x40, filterBytes: [0x80, 0x00, 0x21, 0x01, 0x16] }),
      'FORMAT_CORRUPT_STREAM',
    ],
    ['entier tronqué', stream({}, { flags: 0x40, filterBytes: [0x80, 0x80] }), 'FORMAT_CORRUPT_STREAM'],
    ['entier trop long', stream({}, { flags: 0x40, filterBytes: Array(10).fill(0x80) }), 'FORMAT_CORRUPT_STREAM'],
    [
      'entier au-delà de 2^53',
      stream({}, { flags: 0x40, filterBytes: [...Array(8).fill(0xff), 0x7f, 0x21, 0x01, 0x16] }),
      'FORMAT_CORRUPT_STREAM',
    ],
    ['contrôle de bloc faux', stream({}, { check: new Uint8Array(4) }), 'FORMAT_CORRUPT_STREAM'],
    [
      'remplissage de bloc non nul',
      stream({}, { blockPadding: 0x01, lzma2: lzma2Uncompressed(CONTENT.subarray(1)), content: CONTENT.subarray(1) }),
      'FORMAT_CORRUPT_STREAM',
    ],
    ["CRC de l'en-tête de flux faux", withByte(stream({}), 8, 0x00), 'FORMAT_CORRUPT_STREAM'],
  ])('%s', async (_label, bytes, code) => {
    expect(await codeOf(bytes)).toBe(code);
  });
});

describe('index et pied de flux invalides', () => {
  it.each<[string, Partial<XzStreamSpec>]>([
    ["nombre d'enregistrements", { indexCount: 2 }],
    ["entier trop long dans l'index", { rawIndexCount: Array(10).fill(0x80) }],
    ['enregistrement différent du bloc', { firstRecord: [99, 1] }],
    ["remplissage d'index non nul", { indexPadding: 0x01 }],
    ["CRC d'index faux", { indexCrc: 1 }],
    ['magie de fin', { footerMagic: 'ZY' }],
    ['CRC du pied', { footerCrc: 1 }],
    ['taille arrière', { backwardSize: 7 }],
    ['drapeaux du pied', { footerFlags: [0x00, 0x04] }],
  ])('%s : FORMAT_CORRUPT_STREAM', async (_label, spec) => {
    expect(await codeOf(stream(spec))).toBe('FORMAT_CORRUPT_STREAM');
  });
});

describe('morceaux LZMA2 invalides', () => {
  const real = firstLzmaChunk(corpusFile('xz/text-crc64.xz'));
  const text = Buffer.from(PAYLOADS.text());
  const lzmaBlock = (bytes: number[], content: Uint8Array = text): Uint8Array =>
    buildXz({ blocks: [{ lzma2: Uint8Array.from([...bytes, 0x00]), content }] });

  it('le morceau extrait du corpus est bien un morceau LZMA complet (contrôle 0xE0)', async () => {
    expect(real.control).toBe(0xe0);
    expect(real.uncompressed).toBe(text.length);
    expect((await decode(lzmaBlock(lzmaChunkBytes(real, 0xe0)))).equals(text)).toBe(true);
  });

  it.each<[string, () => number[]]>([
    ['premier morceau sans réinitialisation du dictionnaire', () => [0x02, 0x00, 0x00, 0x41]],
    ['octet de contrôle 0x03', () => [0x01, 0x00, 0x00, 0x41, 0x03]],
    [
      'morceau LZMA sans propriétés après un morceau non compressé',
      () => [0x01, 0x00, 0x00, 0x41, ...lzmaChunkBytes(real, 0x80)],
    ],
    ['morceau LZMA de moins de 5 octets', () => lzmaChunkBytes(real, 0xe0, Uint8Array.of(0, 0, 0, 0))],
    ['propriétés au-delà de 224', () => lzmaChunkBytes(real, 0xe0, real.data, 225)],
    ['lc + lp > 4', () => lzmaChunkBytes(real, 0xe0, real.data, 13)],
    ['données LZMA tronquées', () => lzmaChunkBytes(real, 0xe0, real.data.subarray(0, real.data.length - 1))],
    ['données LZMA en trop', () => lzmaChunkBytes(real, 0xe0, Buffer.concat([real.data, Buffer.alloc(1)]))],
  ])('%s : FORMAT_CORRUPT_STREAM', async (_label, bytes) => {
    expect(await codeOf(lzmaBlock(bytes()))).toBe('FORMAT_CORRUPT_STREAM');
  });
});
