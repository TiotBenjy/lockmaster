// Chemins d'erreur structurels du décodeur bzip2, sur des blocs forgés par l'encodeur de test.
import { describe, expect, it } from 'vitest';
import { decompressToBuffer } from '../../../../src/formats/common/decompress.js';
import { DEFAULT_LIMITS } from '../../../../src/formats/common/limits.js';
import { type Bzip2BlockSpec, buildBzip2 } from '../../../fixtures/builders/bzip2.js';
import { chunked } from './corpus.js';

const OPTIONS = { maxOutputBytes: 8 * 1024 * 1024, limits: DEFAULT_LIMITS };
const CONTENT = Buffer.from('lockmaster banana');

const decode = (bytes: Uint8Array): Promise<Buffer> => decompressToBuffer(chunked(bytes, 5), 'bzip2', OPTIONS);

async function codeOf(bytes: Uint8Array): Promise<string> {
  try {
    await decode(bytes);
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? `erreur sans code : ${String(error)}`;
  }
}

const block = (spec: Partial<Bzip2BlockSpec> = {}, level = 9): Uint8Array =>
  buildBzip2({ level, blocks: [{ content: CONTENT, ...spec }] });

/** RUNA/RUNB (base 2 bijective) d'une répétition de `count` octets. */
function runSymbols(count: number): number[] {
  const symbols: number[] = [];
  let rest = count;
  while (rest > 0) {
    if (rest % 2 === 1) {
      symbols.push(0);
      rest = (rest - 1) / 2;
    } else {
      symbols.push(1);
      rest = (rest - 2) / 2;
    }
  }
  return symbols;
}

describe('blocs bzip2 forgés valides', () => {
  it("l'encodeur de test produit un flux que le décodeur relit", async () => {
    expect((await decode(block())).equals(CONTENT)).toBe(true);
    const two = buildBzip2({ blocks: [{ content: CONTENT }, { content: Buffer.from('abc') }] });
    expect((await decode(two)).toString()).toBe('lockmaster bananaabc');
  });

  it('ignore les sélecteurs au-delà de 18 002', async () => {
    expect((await decode(block({ selectorCount: 18_003 }))).equals(CONTENT)).toBe(true);
  });
});

describe('blocs bzip2 invalides', () => {
  const used = [0x61, 0x62];
  it.each<[string, Uint8Array]>([
    ['une seule table', block({ groups: 1 })],
    ['sept tables', block({ groups: 7 })],
    ['aucun octet présent', block({ used: [] })],
    ['aucun sélecteur', block({ selectorCount: 0 })],
    ['sélecteur hors des tables', block({ selectorRanks: [2] })],
    ['longueur de code nulle', block({ startLength: 0 })],
    ['longueur de code au-delà de 20', block({ startLength: 20, lengthSteps: [1] })],
    ['sélecteurs épuisés', block({ used, selectorCount: 1, symbols: [...Array(60).fill(2), 3] })],
    ['répétition trop longue', block({ used, symbols: [...Array(22).fill(0), 3] })],
    ['répétition au-delà du bloc', block({ used, symbols: [...runSymbols(100_001), 3] }, 1)],
    ['symbole au-delà du bloc', block({ used, selectorCount: 1, symbols: [...runSymbols(100_000), 2, 3] }, 1)],
    ['pointeur origine hors du bloc', block({ origPtr: CONTENT.length })],
    ['code de Huffman invalide', block({ used: [0x61], symbols: [], extraBits: [[3, 2]] })],
    ['CRC de bloc faux', block({ crc: 1 })],
    ['CRC combiné faux', buildBzip2({ blocks: [{ content: CONTENT }], combinedCrc: 1 })],
  ])('%s : FORMAT_CORRUPT_STREAM', async (_label, bytes) => {
    expect(await codeOf(bytes)).toBe('FORMAT_CORRUPT_STREAM');
  });
});
