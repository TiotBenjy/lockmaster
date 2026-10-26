// Encodeur bzip2 minimal pour les tests : codage des répétitions (RLE1), BWT naïve (petits contenus),
// MTF, RUNA/RUNB, tables de Huffman à longueur fixe, un sélecteur par groupe de 50 symboles. Chaque
// champ du bloc peut être remplacé pour forger des flux invalides.

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index << 24;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  return crc >>> 0;
});

export function bzip2Crc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] ?? 0)) >>> 0;
  return ~crc >>> 0;
}

class BitWriter {
  readonly bits: number[] = [];

  write(value: number, count: number): void {
    for (let index = count - 1; index >= 0; index -= 1) this.bits.push(Math.floor(value / 2 ** index) % 2);
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, index) => {
      out[index >> 3] = (out[index >> 3] ?? 0) | (bit << (7 - (index & 7)));
    });
    return out;
  }
}

export interface Bzip2BlockSpec {
  readonly content: Uint8Array;
  readonly crc?: number;
  readonly randomised?: number;
  readonly origPtr?: number;
  readonly used?: readonly number[];
  readonly groups?: number;
  readonly selectorCount?: number;
  /** Rangs MTF des sélecteurs (défaut : tous 0). */
  readonly selectorRanks?: readonly number[];
  /** Longueur initiale de chaque table (5 bits) et pas ±1 écrits avant chaque symbole. */
  readonly startLength?: number;
  readonly lengthSteps?: readonly number[];
  /** Symboles MTF/RUNA/RUNB/EOB à la place de ceux calculés. */
  readonly symbols?: readonly number[];
  /** Bits bruts ajoutés après les symboles (codes invalides). */
  readonly extraBits?: readonly [number, number][];
}

interface Encoded {
  readonly origPtr: number;
  readonly used: number[];
  readonly symbols: number[];
}

function encode(raw: Uint8Array): Encoded {
  const content = runLengthEncode(raw);
  const length = content.length;
  const rotations = Array.from({ length }, (_, index) => index).sort((a, b) => {
    for (let offset = 0; offset < length; offset += 1) {
      const diff = (content[(a + offset) % length] ?? 0) - (content[(b + offset) % length] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  const last = rotations.map((start) => content[(start + length - 1) % length] ?? 0);
  return mtf(content, last, rotations.indexOf(0));
}

/** Codage initial des répétitions de bzip2 : 4 octets égaux puis un compteur (0 à 251) de répétitions. */
function runLengthEncode(content: Uint8Array): Uint8Array {
  const out: number[] = [];
  let index = 0;
  while (index < content.length) {
    const byte = content[index] ?? 0;
    let run = 1;
    while (run < 255 && content[index + run] === byte) run += 1;
    if (run >= 4) {
      out.push(byte, byte, byte, byte, run - 4);
    } else {
      for (let copy = 0; copy < run; copy += 1) out.push(byte);
    }
    index += run;
  }
  return Uint8Array.from(out);
}

function mtf(content: Uint8Array, last: number[], origPtr: number): Encoded {
  const used = [...new Set(content)].sort((a, b) => a - b);
  const order = [...used.keys()];
  const symbols: number[] = [];
  let zeros = 0;
  const flush = (): void => {
    while (zeros > 0) {
      if (zeros % 2 === 1) {
        symbols.push(0);
        zeros = (zeros - 1) / 2;
      } else {
        symbols.push(1);
        zeros = (zeros - 2) / 2;
      }
    }
  };
  for (const byte of last) {
    const rank = order.indexOf(used.indexOf(byte));
    if (rank === 0) {
      zeros += 1;
      continue;
    }
    flush();
    symbols.push(rank + 1);
    order.unshift(...order.splice(rank, 1));
  }
  flush();
  symbols.push(used.length + 1);
  return { origPtr, used, symbols };
}

function writeBlock(writer: BitWriter, spec: Bzip2BlockSpec): number {
  const encoded = encode(spec.content);
  const used = spec.used ?? encoded.used;
  const symbols = spec.symbols ?? encoded.symbols;
  const groups = spec.groups ?? 2;
  const alphabet = used.length + 2;
  const codeLength = Math.max(1, Math.ceil(Math.log2(alphabet)));
  const crc = spec.crc ?? bzip2Crc(spec.content);
  writer.write(0x314159, 24);
  writer.write(0x265359, 24);
  writer.write(crc, 32);
  writer.write(spec.randomised ?? 0, 1);
  writer.write(spec.origPtr ?? encoded.origPtr, 24);
  const present = Array.from({ length: 16 }, (_, group) => used.some((byte) => byte >> 4 === group));
  writer.write(
    present.reduce((mask, on, group) => (on ? mask | (0x8000 >>> group) : mask), 0),
    16,
  );
  present.forEach((on, group) => {
    if (on) for (let index = 0; index < 16; index += 1) writer.write(used.includes(group * 16 + index) ? 1 : 0, 1);
  });
  writer.write(groups, 3);
  const selectorCount = spec.selectorCount ?? Math.max(1, Math.ceil(symbols.length / 50));
  writer.write(selectorCount, 15);
  for (let index = 0; index < selectorCount; index += 1) {
    const rank = spec.selectorRanks?.[index] ?? 0;
    writer.write(2 ** rank - 1, rank);
    writer.write(0, 1);
  }
  for (let table = 0; table < groups; table += 1) {
    writer.write(spec.startLength ?? codeLength, 5);
    for (let symbol = 0; symbol < alphabet; symbol += 1) {
      for (const step of spec.lengthSteps ?? []) writer.write(step > 0 ? 0b10 : 0b11, 2);
      writer.write(0, 1);
    }
  }
  for (const symbol of symbols) writer.write(symbol, codeLength);
  for (const [value, count] of spec.extraBits ?? []) writer.write(value, count);
  return crc;
}

export interface Bzip2StreamSpec {
  readonly level?: number;
  readonly blocks: readonly Bzip2BlockSpec[];
  readonly combinedCrc?: number;
}

export function buildBzip2(spec: Bzip2StreamSpec): Uint8Array {
  const writer = new BitWriter();
  let combined = 0;
  for (const block of spec.blocks) {
    const crc = writeBlock(writer, block);
    combined = (((combined << 1) | (combined >>> 31)) ^ crc) >>> 0;
  }
  writer.write(0x177245, 24);
  writer.write(0x385090, 24);
  writer.write(spec.combinedCrc ?? combined, 32);
  return Buffer.concat([Buffer.from(`BZh${spec.level ?? 9}`, 'latin1'), writer.bytes()]);
}
