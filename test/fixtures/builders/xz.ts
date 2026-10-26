// Écriture de flux .xz pour les tests (xz-file-format.txt 1.2.1) : en-tête de flux, blocs, index,
// pied, avec des CRC recalculés. Les données LZMA2 sont fournies telles quelles (morceaux non
// compressés écrits ici, ou morceau LZMA réel extrait du corpus) ; chaque champ peut être faussé.

import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { Crc64 } from '../../../src/formats/common/xz/crc64.js';

export function vli(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return bytes;
}

const le32 = (value: number): number[] => [...Buffer.from(Uint32Array.of(value >>> 0).buffer)];

/** Morceaux LZMA2 non compressés (0x01 puis 0x02, 64 Kio au plus) suivis du marqueur de fin. */
export function lzma2Uncompressed(data: Uint8Array, end = true): Uint8Array {
  const parts: number[] = [];
  for (let offset = 0; offset < data.length; offset += 65536) {
    const chunk = data.subarray(offset, offset + 65536);
    parts.push(offset === 0 ? 0x01 : 0x02, (chunk.length - 1) >> 8, (chunk.length - 1) & 0xff, ...chunk);
  }
  if (end) parts.push(0x00);
  return Uint8Array.from(parts);
}

export interface XzBlockSpec {
  /** Données LZMA2 brutes (marqueur de fin compris). */
  readonly lzma2: Uint8Array;
  /** Contenu décodé attendu, pour le champ Check et l'index. */
  readonly content: Uint8Array;
  readonly storeSizes?: boolean;
  readonly compressedSize?: number;
  readonly uncompressedSize?: number;
  /** Octets bruts placés après les tailles (défaut : LZMA2, propriétés de dictionnaire 0x16). */
  readonly filterBytes?: readonly number[];
  readonly flags?: number;
  readonly headerPadding?: readonly number[];
  /** Champ Check écrit à la place du vrai. */
  readonly check?: Uint8Array;
  /** Octet de remplissage de bloc (défaut 0). */
  readonly blockPadding?: number;
}

export interface XzStreamSpec {
  readonly checkType?: number;
  readonly streamFlags?: readonly [number, number];
  readonly blocks: readonly XzBlockSpec[];
  readonly indexCount?: number;
  /** Octets bruts du nombre d'enregistrements (entier invalide). */
  readonly rawIndexCount?: readonly number[];
  /** Remplace (taille non remplie, taille décompressée) de l'enregistrement d'index du bloc 0. */
  readonly firstRecord?: readonly [number, number];
  readonly indexPadding?: number;
  readonly indexCrc?: number;
  readonly backwardSize?: number;
  readonly footerFlags?: readonly [number, number];
  readonly footerMagic?: string;
  readonly footerCrc?: number;
}

function checkOf(type: number, content: Uint8Array): Uint8Array {
  if (type === 1) return Uint8Array.from(le32(crc32(content)));
  if (type === 4) {
    const crc = new Crc64();
    crc.update(content);
    return crc.digest();
  }
  if (type === 10) return new Uint8Array(createHash('sha256').update(content).digest());
  return new Uint8Array(0);
}

function blockHeader(block: XzBlockSpec): number[] {
  const sizes = block.storeSizes === true;
  const flags = block.flags ?? (sizes ? 0xc0 : 0x00);
  const body = [
    flags,
    ...(sizes ? vli(block.compressedSize ?? block.lzma2.length) : []),
    ...(sizes ? vli(block.uncompressedSize ?? block.content.length) : []),
    ...(block.filterBytes ?? [0x21, 0x01, 0x16]),
    ...(block.headerPadding ?? []),
  ];
  while ((body.length + 1) % 4 !== 0) body.push(0x00);
  const header = [(body.length + 1 + 4) / 4 - 1, ...body];
  return [...header, ...le32(crc32(Uint8Array.from(header)))];
}

export function buildXz(spec: XzStreamSpec): Uint8Array {
  const checkType = spec.checkType ?? 1;
  const flags = spec.streamFlags ?? [0x00, checkType];
  const out: number[] = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, ...flags, ...le32(crc32(Uint8Array.from(flags)))];
  const records: [number, number][] = [];
  for (const block of spec.blocks) {
    const header = blockHeader(block);
    const check = block.check ?? checkOf(checkType, block.content);
    out.push(...header, ...block.lzma2);
    for (let pad = 0; pad < (4 - (block.lzma2.length % 4)) % 4; pad += 1) out.push(block.blockPadding ?? 0x00);
    out.push(...check);
    records.push([header.length + block.lzma2.length + check.length, block.content.length]);
  }
  if (spec.firstRecord && records.length > 0) records[0] = [...spec.firstRecord];
  const index = [0x00, ...(spec.rawIndexCount ?? vli(spec.indexCount ?? records.length))];
  for (const [unpadded, uncompressed] of records) index.push(...vli(unpadded), ...vli(uncompressed));
  while (index.length % 4 !== 0) index.push(spec.indexPadding ?? 0x00);
  out.push(...index, ...le32(spec.indexCrc ?? crc32(Uint8Array.from(index))));
  const footerBody = [...le32(spec.backwardSize ?? (index.length + 4) / 4 - 1), ...(spec.footerFlags ?? flags)];
  out.push(...le32(spec.footerCrc ?? crc32(Uint8Array.from(footerBody))), ...footerBody);
  out.push(...Buffer.from(spec.footerMagic ?? 'YZ', 'latin1'));
  return Uint8Array.from(out);
}

/** Premier morceau LZMA2 d'un fichier .xz réel : octet de contrôle, tailles, propriétés, données. */
export interface LzmaChunk {
  readonly control: number;
  readonly uncompressed: number;
  readonly props: number;
  readonly data: Uint8Array;
}

export function firstLzmaChunk(file: Uint8Array): LzmaChunk {
  const start = 12 + ((file[12] ?? 0) + 1) * 4;
  const header = file.subarray(start, start + 6);
  const control = header[0] ?? 0;
  const uncompressed = ((control & 0x1f) << 16) + ((header[1] ?? 0) << 8) + (header[2] ?? 0) + 1;
  const compressed = ((header[3] ?? 0) << 8) + (header[4] ?? 0) + 1;
  return {
    control: control & 0xe0,
    uncompressed,
    props: header[5] ?? 0,
    data: file.subarray(start + 6, start + 6 + compressed),
  };
}

/** Réécrit un morceau LZMA avec un octet de contrôle et des propriétés choisis. */
export function lzmaChunkBytes(chunk: LzmaChunk, control: number, data = chunk.data, props = chunk.props): number[] {
  const u = chunk.uncompressed - 1;
  const c = data.length - 1;
  const head = [control | ((u >> 16) & 0x1f), (u >> 8) & 0xff, u & 0xff, (c >> 8) & 0xff, c & 0xff];
  return control >= 0xc0 ? [...head, props, ...data] : [...head, ...data];
}
