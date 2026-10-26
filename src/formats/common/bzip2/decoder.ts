// Décodeur bzip2 écrit d'après le format (ADR-0015) : en-tête `BZh1`..`BZh9`, blocs repérés par la
// magie 0x314159265359 (alignée sur le bit), tables de Huffman et sélecteurs, symboles MTF avec
// RUNA/RUNB, transformée de Burrows-Wheeler inverse, puis décodage des répétitions (4 octets égaux
// suivis d'un compteur). Fin de flux : magie 0x177245385090 et CRC combiné. Flux concaténés admis.
// Les blocs « randomisés » (format antérieur à bzip2 0.9.5) sont refusés.

import { at, at32, atNumber } from '../bytes.js';
import { FormatError, throwIfAborted } from '../errors.js';
import { StreamReader } from '../stream-reader.js';
import { BitReader, corrupt, HuffmanTable, MAX_CODE_LENGTH } from './bits.js';

export interface Bzip2Options {
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

const BLOCK_MAGIC = 0x314159265359;
const END_MAGIC = 0x177245385090;
const GROUP_SIZE = 50;
const MAX_GROUPS = 6;
const MAX_SELECTORS = 2 + 900_000 / GROUP_SIZE;
/** Fenêtre d'entrée d'un bloc : un bloc valide de 900 000 symboles de 20 bits tient en 2,3 Mio. */
const BLOCK_WINDOW_BYTES = 3 * 1024 * 1024;
const OUTPUT_CHUNK_BYTES = 64 * 1024;

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let crc = index << 24;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  CRC_TABLE[index] = crc >>> 0;
}

export async function* decodeBzip2(
  input: AsyncIterable<Uint8Array>,
  options: Bzip2Options,
): AsyncGenerator<Uint8Array> {
  const reader = new StreamReader(input, options.signal);
  const output = { produced: 0, max: options.maxOutputBytes };
  try {
    do {
      yield* decodeStream(reader, output, options.signal);
    } while (!(await reader.atEnd()));
  } finally {
    await reader.close();
  }
}

interface OutputBudget {
  produced: number;
  readonly max: number;
}

async function* decodeStream(
  reader: StreamReader,
  output: OutputBudget,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  const header = await reader.readExact(4);
  const level = at(header, 3) - 0x30;
  if (header[0] !== 0x42 || header[1] !== 0x5a || header[2] !== 0x68 || level < 1 || level > 9) {
    throw corrupt('en-tête absent');
  }
  const tt = new Uint32Array(level * 100_000);
  let bitOffset = 0;
  let combined = 0;
  for (;;) {
    throwIfAborted(signal);
    const bits = new BitReader(await reader.fill(BLOCK_WINDOW_BYTES), bitOffset);
    const magic = bits.bits(24) * 2 ** 24 + bits.bits(24);
    if (magic === END_MAGIC) {
      const stored = (bits.bits(16) * 2 ** 16 + bits.bits(16)) >>> 0;
      reader.skip(Math.ceil(bits.position / 8));
      if (stored !== combined) throw corrupt('CRC combiné faux');
      return;
    }
    if (magic !== BLOCK_MAGIC) throw corrupt('magie de bloc absente');
    const block = readBlock(bits, tt);
    reader.skip(bits.position >>> 3);
    bitOffset = bits.position & 7;
    const crc = new BlockCrc();
    for (const chunk of expandBlock(tt, block)) {
      output.produced += chunk.length;
      if (output.produced > output.max) {
        throw new FormatError('FORMAT_LIMIT_EXCEEDED', `flux bzip2 : sortie au-delà de ${output.max} octets`);
      }
      crc.update(chunk);
      yield chunk;
    }
    if (crc.value() !== block.storedCrc) throw corrupt('CRC de bloc faux');
    combined = (((combined << 1) | (combined >>> 31)) ^ block.storedCrc) >>> 0;
  }
}

interface Block {
  readonly storedCrc: number;
  readonly origPtr: number;
  readonly length: number;
}

/** Lit un bloc jusqu'au symbole de fin ; remplit `tt` (octet en bits 0-7, lien BWT au-dessus). */
function readBlock(bits: BitReader, tt: Uint32Array): Block {
  const storedCrc = (bits.bits(16) * 2 ** 16 + bits.bits(16)) >>> 0;
  if (bits.bit() === 1) {
    throw new FormatError('FORMAT_UNSUPPORTED_COMPRESSION', 'flux bzip2 : bloc randomisé (format obsolète)');
  }
  const origPtr = bits.bits(24);
  const used = readSymbolMap(bits);
  const groups = bits.bits(3);
  if (groups < 2 || groups > MAX_GROUPS) throw corrupt('nombre de tables invalide');
  const selectors = readSelectors(bits, groups);
  const tables = Array.from({ length: groups }, () => readTable(bits, used.length + 2));
  const length = readSymbols(bits, tt, used, selectors, tables);
  if (origPtr >= length) throw corrupt("pointeur d'origine hors du bloc");
  linkBwt(tt, length);
  return { storedCrc, origPtr, length };
}

/** Octets présents dans le bloc : 16 bits de groupes, puis 16 bits par groupe présent. */
function readSymbolMap(bits: BitReader): number[] {
  const groups = bits.bits(16);
  const used: number[] = [];
  for (let group = 0; group < 16; group += 1) {
    if ((groups & (0x8000 >>> group)) === 0) continue;
    for (let index = 0; index < 16; index += 1) if (bits.bit() === 1) used.push(group * 16 + index);
  }
  if (used.length === 0) throw corrupt('bloc sans symbole');
  return used;
}

/** Sélecteurs codés en unaire puis par déplacement en tête (MTF). */
function readSelectors(bits: BitReader, groups: number): Uint8Array {
  const count = bits.bits(15);
  if (count < 1) throw corrupt('aucun sélecteur');
  const order = Uint8Array.from({ length: groups }, (_, index) => index);
  const selectors = new Uint8Array(Math.min(count, MAX_SELECTORS));
  for (let index = 0; index < count; index += 1) {
    let rank = 0;
    while (bits.bit() === 1) {
      rank += 1;
      if (rank >= groups) throw corrupt('sélecteur invalide');
    }
    if (index >= MAX_SELECTORS) continue;
    const table = at(order, rank);
    order.copyWithin(1, 0, rank);
    order[0] = table;
    selectors[index] = table;
  }
  return selectors;
}

/** Longueurs de codes en delta : 5 bits initiaux puis, par symbole, `1x` (+1 ou -1) jusqu'à `0`. */
function readTable(bits: BitReader, alphabetSize: number): HuffmanTable {
  const lengths = new Uint8Array(alphabetSize);
  let current = bits.bits(5);
  for (let symbol = 0; symbol < alphabetSize; symbol += 1) {
    for (;;) {
      if (current < 1 || current > MAX_CODE_LENGTH) throw corrupt('longueur de code invalide');
      if (bits.bit() === 0) break;
      current += bits.bit() === 0 ? 1 : -1;
    }
    lengths[symbol] = current;
  }
  return new HuffmanTable(lengths);
}

/** Symboles MTF : RUNA (0) et RUNB (1) codent une répétition en base 2 bijective ; fin = taille - 1. */
function readSymbols(
  bits: BitReader,
  tt: Uint32Array,
  used: readonly number[],
  selectors: Uint8Array,
  tables: readonly HuffmanTable[],
): number {
  const endOfBlock = used.length + 1;
  const mtf = Uint8Array.from({ length: 256 }, (_, index) => index);
  let group = -1;
  let remainingInGroup = 0;
  let table: HuffmanTable | undefined;
  const next = (): number => {
    if (remainingInGroup === 0) {
      group += 1;
      if (group >= selectors.length) throw corrupt('sélecteurs épuisés');
      table = tables[at(selectors, group)];
      remainingInGroup = GROUP_SIZE;
    }
    remainingInGroup -= 1;
    return (table as HuffmanTable).decode(bits);
  };
  let length = 0;
  let symbol = next();
  while (symbol !== endOfBlock) {
    if (symbol <= 1) {
      let run = 0;
      for (let weight = 1; symbol <= 1; weight *= 2) {
        if (weight >= 2 * 1024 * 1024) throw corrupt('répétition trop longue');
        run += (symbol + 1) * weight;
        symbol = next();
      }
      if (length + run > tt.length) throw corrupt('bloc plus long que sa taille déclarée');
      tt.fill(atNumber(used, at(mtf, 0)), length, length + run);
      length += run;
      continue;
    }
    if (length >= tt.length) throw corrupt('bloc plus long que sa taille déclarée');
    const rank = symbol - 1;
    const value = at(mtf, rank);
    mtf.copyWithin(1, 0, rank);
    mtf[0] = value;
    tt[length] = atNumber(used, value);
    length += 1;
    symbol = next();
  }
  return length;
}

/** Transformée inverse : `tt[i] >> 8` donne la position suivante dans l'ordre d'origine. */
function linkBwt(tt: Uint32Array, length: number): void {
  const starts = new Uint32Array(257);
  for (let index = 0; index < length; index += 1) {
    const slot = (at32(tt, index) & 0xff) + 1;
    starts[slot] = at32(starts, slot) + 1;
  }
  for (let index = 1; index <= 256; index += 1) starts[index] = at32(starts, index) + at32(starts, index - 1);
  for (let index = 0; index < length; index += 1) {
    const byte = at32(tt, index) & 0xff;
    const target = at32(starts, byte);
    tt[target] = (at32(tt, target) | (index << 8)) >>> 0;
    starts[byte] = target + 1;
  }
}

/** Parcourt la BWT inverse et défait le codage des répétitions (4 octets égaux + compteur). */
function* expandBlock(tt: Uint32Array, block: Block): Generator<Uint8Array> {
  let chunk = new Uint8Array(OUTPUT_CHUNK_BYTES);
  let used = 0;
  let position = at32(tt, block.origPtr) >>> 8;
  let previous = -1;
  let run = 0;
  for (let index = 0; index < block.length; index += 1) {
    const entry = at32(tt, position);
    position = entry >>> 8;
    let value = entry & 0xff;
    let times = 1;
    if (run === 4) {
      times = value;
      value = previous;
      run = 0;
    } else {
      run = value === previous ? run + 1 : 1;
      previous = value;
    }
    while (times > 0) {
      const count = Math.min(times, chunk.length - used);
      chunk.fill(value, used, used + count);
      used += count;
      times -= count;
      if (used === chunk.length) {
        yield chunk;
        chunk = new Uint8Array(OUTPUT_CHUNK_BYTES);
        used = 0;
      }
    }
  }
  if (used > 0) yield chunk.subarray(0, used);
}

/** CRC32 de bzip2 : polynôme 0x04C11DB7, bits de poids fort d'abord. */
class BlockCrc {
  #crc = 0xffffffff;

  update(bytes: Uint8Array): void {
    let crc = this.#crc;
    for (let index = 0; index < bytes.length; index += 1) {
      crc = ((crc << 8) ^ at32(CRC_TABLE, ((crc >>> 24) ^ at(bytes, index)) & 0xff)) >>> 0;
    }
    this.#crc = crc;
  }

  value(): number {
    return ~this.#crc >>> 0;
  }
}
