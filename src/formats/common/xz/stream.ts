// Décodeur du conteneur .xz (xz-file-format.txt 1.2.1 ; portage de xz_dec_stream.c d'XZ Embedded :
// Copyright (C) The XZ Embedded authors and contributors, licence 0BSD, ADR-0015). Pris en charge :
// flux concaténés avec remplissage, blocs LZMA2 seuls, contrôles None, CRC32, CRC64 et SHA-256.
// Refusé (FORMAT_UNSUPPORTED_COMPRESSION) : filtres BCJ et Delta, contrôles inconnus, options
// réservées. Toute incohérence (CRC, tailles, index, fin prématurée) : FORMAT_CORRUPT_STREAM.

import { createHash, type Hash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { at } from '../bytes.js';
import { FormatError } from '../errors.js';
import { checkStreamCount } from '../limits.js';
import { StreamReader } from '../stream-reader.js';
import { Crc64 } from './crc64.js';
import { Dictionary } from './dictionary.js';
import { Lzma2Decoder, type ReserveOutput } from './lzma2.js';

export interface XzOptions {
  readonly maxOutputBytes: number;
  readonly maxDictionaryBytes: number;
  readonly signal?: AbortSignal;
}

const HEADER_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
const FOOTER_MAGIC = [0x59, 0x5a];
const CHECK_SIZES: Readonly<Record<number, number>> = { 0: 0, 1: 4, 4: 8, 10: 32 };
const LZMA2_FILTER_ID = 0x21;
const DICTIONARY_GRANULE = 4096;

const corrupt = (reason: string): FormatError => new FormatError('FORMAT_CORRUPT_STREAM', `flux xz : ${reason}`);
const unsupported = (reason: string): FormatError =>
  new FormatError('FORMAT_UNSUPPORTED_COMPRESSION', `flux xz : ${reason}`);

export async function* decodeXz(input: AsyncIterable<Uint8Array>, options: XzOptions): AsyncGenerator<Uint8Array> {
  const reader = new StreamReader(input, options.signal);
  let produced = 0;
  const reserve: ReserveOutput = (bytes) => {
    produced += bytes;
    if (produced > options.maxOutputBytes) {
      throw new FormatError('FORMAT_LIMIT_EXCEEDED', `flux xz : sortie au-delà de ${options.maxOutputBytes} octets`);
    }
  };
  const dictionary = new Dictionary();
  try {
    let streams = 0;
    do {
      streams += 1;
      checkStreamCount(streams, reader.position);
      yield* decodeStream(reader, dictionary, reserve, options);
      await skipStreamPadding(reader);
    } while (!(await reader.atEnd()));
  } finally {
    await reader.close();
  }
}

/** Remplissage entre flux : des octets nuls en nombre multiple de 4. */
async function skipStreamPadding(reader: StreamReader): Promise<void> {
  let count = 0;
  while ((await reader.peekByte()) === 0x00) {
    reader.skip(1);
    count += 1;
  }
  if (count % 4 !== 0) throw corrupt('remplissage de flux invalide');
}

interface BlockRecord {
  count: number;
  hash: number;
}

async function* decodeStream(
  reader: StreamReader,
  dictionary: Dictionary,
  reserve: ReserveOutput,
  options: XzOptions,
): AsyncGenerator<Uint8Array> {
  const checkType = readStreamHeader(await reader.readExact(12));
  const blocks: BlockRecord = { count: 0, hash: 0 };
  for (;;) {
    const first = await reader.readByte();
    if (first === 0x00) break;
    const header = await reader.readExact((first + 1) * 4 - 1);
    const block = parseBlockHeader(Uint8Array.of(first, ...header), options);
    const start = reader.position;
    const check = newCheck(checkType);
    let uncompressed = 0;
    dictionary.configure(block.dictionarySize, block.capacity);
    for await (const chunk of new Lzma2Decoder(dictionary).run(reader, reserve)) {
      check.update(chunk);
      uncompressed += chunk.length;
      yield chunk;
    }
    const compressed = reader.position - start;
    if ((block.compressed ?? compressed) !== compressed || (block.uncompressed ?? uncompressed) !== uncompressed) {
      throw corrupt("tailles de bloc différentes de l'en-tête");
    }
    await expectZeros(reader, (4 - (compressed % 4)) % 4, 'remplissage de bloc invalide');
    const expected = check.digest();
    if (!equal(await reader.readExact(expected.length), expected)) throw corrupt('contrôle de bloc faux');
    const unpadded = block.headerSize + compressed + expected.length;
    blocks.count += 1;
    blocks.hash = recordHash(blocks.hash, unpadded, uncompressed);
  }
  const indexSize = await readIndex(reader, blocks);
  readStreamFooter(await reader.readExact(12), indexSize, checkType);
}

function readStreamHeader(header: Uint8Array): number {
  if (!HEADER_MAGIC.every((byte, index) => header[index] === byte)) throw corrupt('magie absente');
  if (crc32(header.subarray(6, 8)) !== readUint32(header, 8)) throw corrupt("CRC de l'en-tête de flux faux");
  const checkType = at(header, 7);
  if (header[6] !== 0x00 || CHECK_SIZES[checkType] === undefined)
    throw unsupported('options de flux non prises en charge');
  return checkType;
}

function readStreamFooter(footer: Uint8Array, indexSize: number, checkType: number): void {
  if (footer[10] !== FOOTER_MAGIC[0] || footer[11] !== FOOTER_MAGIC[1]) throw corrupt('magie de fin absente');
  if (crc32(footer.subarray(4, 10)) !== readUint32(footer, 0)) throw corrupt('CRC du pied de flux faux');
  if (readUint32(footer, 4) !== indexSize / 4 - 1) throw corrupt("taille d'index incohérente");
  if (footer[8] !== 0x00 || footer[9] !== checkType) throw corrupt('options du pied de flux incohérentes');
}

interface BlockHeader {
  readonly headerSize: number;
  readonly compressed: number | undefined;
  readonly uncompressed: number | undefined;
  readonly dictionarySize: number;
  readonly capacity: number;
}

function parseBlockHeader(header: Uint8Array, options: XzOptions): BlockHeader {
  const body = header.length - 4;
  if (crc32(header.subarray(0, body)) !== readUint32(header, body)) throw corrupt("CRC de l'en-tête de bloc faux");
  const flags = at(header, 1);
  if ((flags & 0x3f) !== 0) throw unsupported('filtres ou options de bloc non pris en charge (BCJ, Delta...)');
  const cursor = { position: 2 };
  const compressed = (flags & 0x40) !== 0 ? readVli(header, cursor, body) : undefined;
  const uncompressed = (flags & 0x80) !== 0 ? readVli(header, cursor, body) : undefined;
  if (compressed === 0) throw corrupt('taille compressée nulle');
  if (body - cursor.position < 3) throw corrupt('en-tête de bloc tronqué');
  if (header[cursor.position] !== LZMA2_FILTER_ID || header[cursor.position + 1] !== 0x01) {
    throw unsupported('filtre autre que LZMA2');
  }
  const props = at(header, cursor.position + 2);
  if (props > 39) throw unsupported('dictionnaire LZMA2 au-delà de 3 Gio');
  for (let index = cursor.position + 3; index < body; index += 1) {
    if (header[index] !== 0x00) throw unsupported("remplissage d'en-tête de bloc non nul");
  }
  const dictionarySize = (2 + (props & 1)) * 2 ** ((props >>> 1) + 11);
  const bound = Math.min(options.maxDictionaryBytes, options.maxOutputBytes);
  const capacity = Math.min(dictionarySize, Math.ceil(Math.max(bound, 1) / DICTIONARY_GRANULE) * DICTIONARY_GRANULE);
  return { headerSize: header.length, compressed, uncompressed, dictionarySize, capacity };
}

/** Index : nombre d'enregistrements, puis (taille non remplie, taille décompressée) par bloc. */
async function readIndex(reader: StreamReader, blocks: BlockRecord): Promise<number> {
  const digest = new IndexDigest();
  digest.add(0x00);
  const next = async (): Promise<number> => digest.add(await reader.readByte());
  if ((await readStreamVli(next)) !== blocks.count) throw corrupt("nombre d'enregistrements d'index incohérent");
  let hash = 0;
  for (let index = 0; index < blocks.count; index += 1) {
    const unpadded = await readStreamVli(next);
    hash = recordHash(hash, unpadded, await readStreamVli(next));
  }
  while (digest.size % 4 !== 0) {
    if ((await next()) !== 0x00) throw corrupt("remplissage d'index invalide");
  }
  if (hash !== blocks.hash) throw corrupt('index différent des blocs');
  if (readUint32(await reader.readExact(4), 0) !== digest.value()) throw corrupt("CRC de l'index faux");
  return digest.size + 4;
}

/** CRC32 de l'index, calculé par paquets pour ne pas appeler `crc32` à chaque octet. */
class IndexDigest {
  readonly #pending = new Uint8Array(4096);
  #used = 0;
  #crc = 0;
  size = 0;

  add(byte: number): number {
    this.#pending[this.#used] = byte;
    this.#used += 1;
    this.size += 1;
    if (this.#used === this.#pending.length) this.#flush();
    return byte;
  }

  value(): number {
    this.#flush();
    return this.#crc;
  }

  #flush(): void {
    this.#crc = crc32(this.#pending.subarray(0, this.#used), this.#crc);
    this.#used = 0;
  }
}

/** Empreinte chaînée des enregistrements (taille non remplie, taille décompressée). */
function recordHash(previous: number, unpadded: number, uncompressed: number): number {
  const record = new DataView(new ArrayBuffer(16));
  record.setBigUint64(0, BigInt(unpadded), true);
  record.setBigUint64(8, BigInt(uncompressed), true);
  return crc32(new Uint8Array(record.buffer), previous);
}

/** Entier de longueur variable (base 128, petit-boutiste, au plus 9 octets, encodage minimal). */
function readVli(bytes: Uint8Array, cursor: { position: number }, end: number): number {
  let value = 0;
  for (let shift = 0; shift < 63; shift += 7) {
    if (cursor.position >= end) throw corrupt('entier tronqué');
    const byte = at(bytes, cursor.position);
    cursor.position += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return checkedVli(value, byte, shift);
  }
  throw corrupt('entier trop long');
}

async function readStreamVli(next: () => Promise<number>): Promise<number> {
  let value = 0;
  for (let shift = 0; shift < 63; shift += 7) {
    const byte = await next();
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return checkedVli(value, byte, shift);
  }
  throw corrupt('entier trop long');
}

function checkedVli(value: number, lastByte: number, shift: number): number {
  if (lastByte === 0 && shift !== 0) throw corrupt('entier non minimal');
  if (!Number.isSafeInteger(value)) throw corrupt('entier hors limites');
  return value;
}

interface Check {
  update(bytes: Uint8Array): void;
  digest(): Uint8Array;
}

function newCheck(checkType: number): Check {
  if (checkType === 1) {
    let value = 0;
    return {
      update: (bytes) => {
        value = crc32(bytes, value);
      },
      digest: () => {
        const result = new Uint8Array(4);
        new DataView(result.buffer).setUint32(0, value, true);
        return result;
      },
    };
  }
  if (checkType === 4) return new Crc64();
  if (checkType === 10) return sha256Check(createHash('sha256'));
  return { update: () => undefined, digest: () => new Uint8Array(0) };
}

function sha256Check(hash: Hash): Check {
  return { update: (bytes) => hash.update(bytes), digest: () => new Uint8Array(hash.digest()) };
}

async function expectZeros(reader: StreamReader, count: number, reason: string): Promise<void> {
  const bytes = await reader.readExact(count);
  if (bytes.some((byte) => byte !== 0)) throw corrupt(reason);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
