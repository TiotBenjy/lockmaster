// Générateur de paquets RPM v4 pour les tests (lib/rpmlead.c, lib/header.c de rpm 4.19) : lead de
// 96 octets, en-tête de signature (région 62, complété à 8 octets), en-tête principal (région 63),
// payload cpio « newc » compressé. Chaque élément peut être faussé pour le corpus malformé.

import { createHash } from 'node:crypto';
import { compress, type FixtureCompression } from './compress.js';

export const TYPE = { CHAR: 1, INT8: 2, INT16: 3, INT32: 4, INT64: 5, STRING: 6, BIN: 7, STRING_ARRAY: 8, I18N: 9 };
const ALIGN: Readonly<Record<number, number>> = { 3: 2, 4: 4, 5: 8 };

export interface RpmTag {
  readonly tag: number;
  readonly type: number;
  readonly value: string | readonly string[] | number | readonly number[] | bigint | Uint8Array;
  /** Nombre d'éléments écrit à la place du vrai. */
  readonly count?: number;
}

function encodeValue(entry: RpmTag): { bytes: Uint8Array; count: number } {
  const { type, value } = entry;
  if (value instanceof Uint8Array) return { bytes: value, count: value.length };
  if (typeof value === 'string') return { bytes: Buffer.from(`${value}\0`, 'utf8'), count: 1 };
  if (typeof value === 'bigint') {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(value);
    return { bytes, count: 1 };
  }
  const values: readonly (string | number)[] = Array.isArray(value) ? value : [value as number];
  if (type === TYPE.STRING_ARRAY || type === TYPE.I18N) {
    return { bytes: Buffer.concat(values.map((text) => Buffer.from(`${text}\0`, 'utf8'))), count: values.length };
  }
  const size = type === TYPE.INT16 ? 2 : type === TYPE.INT32 ? 4 : 1;
  const bytes = Buffer.alloc(size * values.length);
  values.forEach((number, index) => {
    if (size === 2) bytes.writeUInt16BE(Number(number), index * 2);
    else if (size === 4) bytes.writeUInt32BE(Number(number) >>> 0, index * 4);
    else bytes.writeUInt8(Number(number), index);
  });
  return { bytes, count: values.length };
}

export interface HeaderOptions {
  /** Champs de la région (tag, type, nombre) et du trailer écrits à la place des vrais. */
  readonly region?: { tag?: number; type?: number; count?: number };
  readonly trailer?: { tag?: number; offset?: number };
  readonly magic?: Uint8Array;
  /** Remplace (index, champ) d'une entrée d'index après écriture. */
  readonly patchIndex?: readonly [entry: number, field: 'tag' | 'type' | 'offset' | 'count', value: number][];
}

/** En-tête RPM : magie, il, dl, index (région en tête), données (trailer de région à la fin). */
export function buildHeader(tags: readonly RpmTag[], regionTag: number, options: HeaderOptions = {}): Uint8Array {
  const sorted = [...tags].sort((a, b) => a.tag - b.tag);
  const index: number[][] = [];
  const parts: Uint8Array[] = [];
  let size = 0;
  for (const entry of sorted) {
    const align = ALIGN[entry.type] ?? 1;
    const padding = (align - (size % align)) % align;
    if (padding > 0) parts.push(new Uint8Array(padding));
    size += padding;
    const { bytes, count } = encodeValue(entry);
    index.push([entry.tag, entry.type, size, entry.count ?? count]);
    parts.push(bytes);
    size += bytes.length;
  }
  const il = sorted.length + 1;
  const trailer = Buffer.alloc(16);
  trailer.writeUInt32BE(options.trailer?.tag ?? regionTag, 0);
  trailer.writeUInt32BE(TYPE.BIN, 4);
  trailer.writeInt32BE(options.trailer?.offset ?? -(16 * il), 8);
  trailer.writeUInt32BE(16, 12);
  const region = [
    options.region?.tag ?? regionTag,
    options.region?.type ?? TYPE.BIN,
    size,
    options.region?.count ?? 16,
  ];
  const entries = [region, ...index];
  for (const [entry, field, value] of options.patchIndex ?? []) {
    const target = entries[entry];
    if (target) target[['tag', 'type', 'offset', 'count'].indexOf(field)] = value;
  }
  const head = Buffer.alloc(16 + 16 * il);
  Buffer.from(options.magic ?? Uint8Array.of(0x8e, 0xad, 0xe8, 0x01, 0, 0, 0, 0)).copy(head, 0);
  head.writeUInt32BE(il, 8);
  head.writeUInt32BE(size + 16, 12);
  entries.forEach((values, position) => {
    values.forEach((value, field) => {
      head.writeInt32BE(value | 0, 16 + position * 16 + field * 4);
    });
  });
  return Buffer.concat([head, ...parts, trailer]);
}

export interface CpioFile {
  readonly name: string;
  readonly data?: string;
  readonly mode?: number;
}

/** Archive cpio « newc » (magie 070701), terminée par TRAILER!!!. */
export function buildCpio(files: readonly CpioFile[]): Uint8Array {
  const parts: Buffer[] = [];
  const pad = (length: number): Buffer => Buffer.alloc((4 - (length % 4)) % 4);
  [...files, { name: 'TRAILER!!!', data: '', mode: 0 }].forEach((file, ino) => {
    const data = Buffer.from(file.data ?? '', 'utf8');
    const name = Buffer.from(`${file.name}\0`, 'utf8');
    const fields = [ino + 1, file.mode ?? 0o100644, 0, 0, 1, 0, data.length, 0, 0, 0, 0, name.length, 0];
    const header = `070701${fields.map((value) => value.toString(16).padStart(8, '0')).join('')}`;
    parts.push(Buffer.from(header, 'latin1'), name, pad(110 + name.length), data, pad(data.length));
  });
  return Buffer.concat(parts);
}

export interface RpmSpec {
  readonly name?: string;
  readonly version?: string;
  readonly release?: string;
  readonly epoch?: number;
  readonly arch?: string;
  /** Entrées ajoutées ou remplaçant celles par défaut (même tag). */
  readonly tags?: readonly RpmTag[];
  /** Tags par défaut retirés. */
  readonly omit?: readonly number[];
  readonly files?: readonly CpioFile[];
  readonly compression?: FixtureCompression;
  /** Nom écrit dans PAYLOADCOMPRESSOR (défaut : celui de la compression ; null pour ne rien écrire). */
  readonly compressorName?: string | null;
  readonly lead?: { magic?: Uint8Array; major?: number; type?: number; signatureType?: number };
  readonly signatureTags?: readonly RpmTag[];
  readonly signatureOmit?: readonly number[];
  readonly headerOptions?: HeaderOptions;
  readonly signatureOptions?: HeaderOptions;
  /** Octets ajoutés après le payload. */
  readonly trailing?: Uint8Array;
}

const COMPRESSOR_NAMES: Readonly<Record<FixtureCompression, string>> = {
  none: 'ufdio',
  gzip: 'gzip',
  zstd: 'zstd',
  xz: 'xz',
  bzip2: 'bzip2',
  lzma: 'lzma',
};

function merge(defaults: readonly RpmTag[], overrides: readonly RpmTag[], omit: readonly number[]): RpmTag[] {
  const byTag = new Map(defaults.map((entry) => [entry.tag, entry]));
  for (const entry of overrides) byTag.set(entry.tag, entry);
  for (const tag of omit) byTag.delete(tag);
  return [...byTag.values()];
}

export function defaultTags(spec: RpmSpec, files: readonly CpioFile[]): RpmTag[] {
  const compression = spec.compression ?? 'gzip';
  const compressor = spec.compressorName === undefined ? COMPRESSOR_NAMES[compression] : spec.compressorName;
  const paths = files.map((file) => `/${file.name.replace(/^\.\//, '')}`);
  const dirs = [...new Set(paths.map((path) => path.slice(0, path.lastIndexOf('/') + 1)))];
  const tags: RpmTag[] = [
    { tag: 100, type: TYPE.STRING_ARRAY, value: ['C'] },
    { tag: 1000, type: TYPE.STRING, value: spec.name ?? 'hello' },
    { tag: 1001, type: TYPE.STRING, value: spec.version ?? '2.10' },
    { tag: 1002, type: TYPE.STRING, value: spec.release ?? '3.el9' },
    { tag: 1004, type: TYPE.I18N, value: ['Programme de démonstration'] },
    { tag: 1005, type: TYPE.I18N, value: ['Description longue.\nDeuxième ligne.'] },
    { tag: 1006, type: TYPE.INT32, value: 1_700_000_000 },
    { tag: 1007, type: TYPE.STRING, value: 'build.example.org' },
    { tag: 1009, type: TYPE.INT32, value: 42 },
    { tag: 1014, type: TYPE.STRING, value: 'MIT' },
    { tag: 1016, type: TYPE.I18N, value: ['Unspecified'] },
    { tag: 1020, type: TYPE.STRING, value: 'https://example.org' },
    { tag: 1021, type: TYPE.STRING, value: 'linux' },
    { tag: 1022, type: TYPE.STRING, value: spec.arch ?? 'x86_64' },
    { tag: 1044, type: TYPE.STRING, value: 'hello-2.10-3.el9.src.rpm' },
    { tag: 1047, type: TYPE.STRING_ARRAY, value: ['hello', 'hello(x86-64)'] },
    { tag: 1048, type: TYPE.INT32, value: [0x4000 | 8 | 4, 0x1000000 | 8 | 2, 0] },
    { tag: 1049, type: TYPE.STRING_ARRAY, value: ['libc.so.6()(64bit)', 'rpmlib(PayloadIsXz)', '/bin/sh'] },
    { tag: 1050, type: TYPE.STRING_ARRAY, value: ['2.34', '5.2-1', ''] },
    { tag: 1053, type: TYPE.INT32, value: [2] },
    { tag: 1054, type: TYPE.STRING_ARRAY, value: ['hello-old'] },
    { tag: 1055, type: TYPE.STRING_ARRAY, value: ['2.0'] },
    { tag: 1090, type: TYPE.STRING_ARRAY, value: ['hello-legacy'] },
    { tag: 1112, type: TYPE.INT32, value: [8, 8] },
    { tag: 1113, type: TYPE.STRING_ARRAY, value: ['2.10-3.el9', '2.10-3.el9'] },
    { tag: 1114, type: TYPE.INT32, value: [2 | 8] },
    { tag: 1115, type: TYPE.STRING_ARRAY, value: ['1:1.0-1'] },
    { tag: 1116, type: TYPE.INT32, value: paths.map((path) => dirs.indexOf(path.slice(0, path.lastIndexOf('/') + 1))) },
    { tag: 1117, type: TYPE.STRING_ARRAY, value: paths.map((path) => path.slice(path.lastIndexOf('/') + 1)) },
    { tag: 1118, type: TYPE.STRING_ARRAY, value: dirs },
    { tag: 1030, type: TYPE.INT16, value: files.map((file) => file.mode ?? 0o100644) },
    { tag: 1124, type: TYPE.STRING, value: 'cpio' },
  ];
  if (compressor !== null) tags.push({ tag: 1125, type: TYPE.STRING, value: compressor });
  if (spec.epoch !== undefined) tags.push({ tag: 1003, type: TYPE.INT32, value: spec.epoch });
  return tags;
}

export function buildRpm(spec: RpmSpec = {}): Uint8Array {
  const files = spec.files ?? [{ name: './usr/bin/hello', data: '#!/bin/sh\necho bonjour\n', mode: 0o100755 }];
  const payload = compress(buildCpio(files), spec.compression ?? 'gzip');
  const payloadDigest = createHash('sha256').update(payload).digest('hex');
  const mainTags = merge(
    [
      ...defaultTags(spec, files),
      { tag: 5092, type: TYPE.STRING_ARRAY, value: [payloadDigest] },
      { tag: 5093, type: TYPE.INT32, value: 8 },
    ],
    spec.tags ?? [],
    spec.omit ?? [],
  );
  const header = buildHeader(mainTags, 63, spec.headerOptions);
  const signature = buildHeader(
    merge(
      [
        { tag: 269, type: TYPE.STRING, value: createHash('sha1').update(header).digest('hex') },
        { tag: 273, type: TYPE.STRING, value: createHash('sha256').update(header).digest('hex') },
        { tag: 1000, type: TYPE.INT32, value: header.length + payload.length },
      ],
      spec.signatureTags ?? [],
      spec.signatureOmit ?? [],
    ),
    62,
    spec.signatureOptions,
  );
  const lead = Buffer.alloc(96);
  Buffer.from(spec.lead?.magic ?? Uint8Array.of(0xed, 0xab, 0xee, 0xdb)).copy(lead, 0);
  lead[4] = spec.lead?.major ?? 3;
  lead[5] = 0;
  lead.writeUInt16BE(spec.lead?.type ?? 0, 6);
  lead.writeUInt16BE(1, 8);
  lead.write('hello-2.10-3.el9', 10, 66, 'latin1');
  lead.writeUInt16BE(1, 76);
  lead.writeUInt16BE(spec.lead?.signatureType ?? 5, 78);
  const padding = Buffer.alloc((8 - (signature.length % 8)) % 8);
  return Buffer.concat([lead, signature, padding, header, payload, spec.trailing ?? new Uint8Array(0)]);
}
