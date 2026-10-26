// Lecture d'un en-tête RPM (signature ou principal) avec les contrôles de rpm 4.19 (lib/header.c :
// hdrblobVerifyLengths, hdrblobInit, hdrblobVerifyRegion avec exact_size, hdrblobVerifyInfo, dataLength).
// Format : magie 8E AD E8 01 00 00 00 00, il et dl (32 bits gros-boutistes), il entrées de 16 octets
// {tag, type, décalage, nombre}, dl octets de données ; la première entrée est la région, dont le
// trailer de 16 octets termine les données.

import { at } from '../common/bytes.js';
import { FormatError } from '../common/errors.js';
import type { FormatLimits } from '../common/limits.js';
import { MAIN_TYPES, REGION, RPM_TYPE } from './tags.js';

export type HeaderKind = 'signature' | 'main';

interface Entry {
  readonly type: number;
  readonly count: number;
  readonly data: Uint8Array;
  /** Chaînes décodées (UTF-8 strict) dès la lecture, pour les types chaîne. */
  readonly strings: readonly string[];
}

export interface RpmHeader {
  /** Octets de l'en-tête, magie comprise (base des empreintes SHA1HEADER et SHA256HEADER). */
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  has(tag: number): boolean;
  /** Chaîne simple, ou chaîne traduite (une seule traduction admise). */
  string(tag: number): string | undefined;
  /** Tableau de chaînes (type STRING_ARRAY exact). */
  strings(tag: number): string[];
  uint16(tag: number): number[];
  uint32(tag: number): number[];
  uint64(tag: number): number[];
}

const MAGIC = [0x8e, 0xad, 0xe8, 0x01, 0, 0, 0, 0];
const ENTRY_BYTES = 16;
/** typeSizes de lib/header.c, indexé par type (les chaînes sont mesurées à part). */
const TYPE_SIZES = Uint8Array.of(0, 1, 1, 2, 4, 8, 0, 1);
const STRING_CLASS = new Set<number>([RPM_TYPE.STRING, RPM_TYPE.STRING_ARRAY, RPM_TYPE.I18NSTRING]);
/** HEADER_ARRAY_MAX de lib/header.c. */
const ARRAY_MAX = 0xfffff;
const utf8 = new TextDecoder('utf-8', { fatal: true });

const invalid = (reason: string): FormatError => new FormatError('FORMAT_INVALID', `en-tête RPM : ${reason}`);

/** Bornes de hdrblobVerifyLengths, resserrées par `limits.ts` pour l'en-tête principal. */
function maxima(kind: HeaderKind, limits: FormatLimits): { il: number; dl: number } {
  if (kind === 'signature') return { il: 32, dl: 64 * 1024 * 1024 };
  return { il: Math.min(0xffff, limits.rpmMaxIndexEntries), dl: Math.min(0x0fffffff, limits.rpmMaxStoreBytes) };
}

/** Taille totale annoncée par les 16 premiers octets (après contrôle des bornes). */
export function headerLength(prefix: Uint8Array, kind: HeaderKind, limits: FormatLimits): number {
  if (prefix.length < 16) throw new FormatError('FORMAT_TRUNCATED', 'en-tête RPM tronqué');
  if (!MAGIC.every((byte, index) => prefix[index] === byte)) throw invalid('magie absente');
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  const il = view.getUint32(8);
  const dl = view.getUint32(12);
  const max = maxima(kind, limits);
  if (il > max.il || dl > max.dl) throw new FormatError('FORMAT_LIMIT_EXCEEDED', 'en-tête RPM trop grand');
  if (il < 1) throw invalid('aucune entrée');
  return 16 + ENTRY_BYTES * il + dl;
}

export function parseRpmHeader(bytes: Uint8Array, kind: HeaderKind, limits: FormatLimits): RpmHeader {
  const length = headerLength(bytes, kind, limits);
  if (bytes.length < length) throw new FormatError('FORMAT_TRUNCATED', 'en-tête RPM tronqué');
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);
  const il = view.getUint32(8);
  const dl = view.getUint32(12);
  const data = bytes.subarray(16 + ENTRY_BYTES * il, length);
  const info = (index: number) => {
    const base = 16 + ENTRY_BYTES * index;
    return {
      tag: view.getUint32(base),
      type: view.getUint32(base + 4),
      offset: view.getInt32(base + 8),
      count: view.getUint32(base + 12),
    };
  };
  const rdl = checkRegion(info(0), data, il, dl, kind);
  const entries = new Map<number, Entry>();
  let end = 0;
  for (let index = 1; index < il; index += 1) {
    const entry = info(index);
    if (end > entry.offset) throw invalid('entrées qui se chevauchent');
    checkEntry(entry, dl, kind);
    const entryLength = dataLength(entry.type, data.subarray(0, rdl - ENTRY_BYTES), entry.offset, entry.count);
    end = entry.offset + entryLength;
    if (end > dl) throw invalid('données hors limites');
    if (end > rdl - ENTRY_BYTES && entry.offset < rdl) throw invalid('données sur le trailer de région');
    const value = data.subarray(entry.offset, end);
    // rpm lit l'une ou l'autre entrée d'un tag répété (bsearch sur un tri instable, findEntry) : seule
    // une répétition identique (type, nombre, octets) est sans ambiguïté. rpmbuild 4.19.1.1 de Rocky 10
    // écrit ainsi SOURCERPM deux fois.
    const previous = entries.get(entry.tag);
    if (previous !== undefined) {
      const same =
        previous.type === entry.type && previous.count === entry.count && Buffer.from(previous.data).equals(value);
      if (!same) throw invalid(`tag ${entry.tag} répété avec une autre valeur`);
      continue;
    }
    const strings = STRING_CLASS.has(entry.type) ? decode(value).split('\0').slice(0, entry.count) : [];
    entries.set(entry.tag, { type: entry.type, count: entry.count, data: value, strings });
  }
  return accessors(bytes.subarray(0, length), entries);
}

interface Info {
  readonly tag: number;
  readonly type: number;
  readonly offset: number;
  readonly count: number;
}

/** hdrblobVerifyRegion avec exact_size : la région couvre tout l'en-tête ; rend rdl. */
function checkRegion(region: Info, data: Uint8Array, il: number, dl: number, kind: HeaderKind): number {
  const expected = kind === 'signature' ? REGION.SIGNATURES : REGION.IMMUTABLE;
  if (region.tag !== expected || region.type !== RPM_TYPE.BIN || region.count !== ENTRY_BYTES) {
    throw invalid('région absente ou invalide');
  }
  if (region.offset < 0 || region.offset + ENTRY_BYTES > dl) throw invalid('région hors des données');
  const trailer = new DataView(data.buffer, data.byteOffset + region.offset, ENTRY_BYTES);
  const tag = trailer.getUint32(0);
  const tagOk = tag === expected || (kind === 'signature' && tag === REGION.IMAGE);
  if (!tagOk || trailer.getUint32(4) !== RPM_TYPE.BIN || trailer.getUint32(12) !== ENTRY_BYTES) {
    throw invalid('trailer de région invalide');
  }
  const size = -trailer.getInt32(8);
  const rdl = region.offset + ENTRY_BYTES;
  if (size % ENTRY_BYTES !== 0 || size / ENTRY_BYTES !== il || rdl !== dl) throw invalid('taille de région');
  return rdl;
}

/** hdrblobVerifyInfo, contrôles par entrée avant la longueur des données. */
function checkEntry(entry: Info, dl: number, kind: HeaderKind): void {
  if (entry.tag < REGION.I18NTABLE) throw invalid('tag réservé');
  if (entry.type < RPM_TYPE.CHAR || entry.type > RPM_TYPE.I18NSTRING) throw invalid('type inconnu');
  if (entry.count < 1 || entry.count > dl) throw invalid("nombre d'éléments");
  const align =
    entry.type === RPM_TYPE.INT16 ? 2 : entry.type === RPM_TYPE.INT32 ? 4 : entry.type === RPM_TYPE.INT64 ? 8 : 1;
  if (entry.offset % align !== 0) throw invalid('alignement');
  if (entry.offset < 0 || entry.offset > dl) throw invalid('décalage hors limites');
  if (entry.type !== RPM_TYPE.BIN && entry.count > ARRAY_MAX) throw invalid('tableau trop grand');
  // rpm tolère un autre type de la classe chaîne (hdrchkTagType), mais lit alors une traduction choisie
  // selon la locale du client (copyI18NEntry) : type exact exigé, sauf STRING (un seul élément, lu de
  // la même façon partout) pour un tag traduit ou un tableau. rpmbuild écrit d'ailleurs un *PROG en
  // STRING quand l'interpréteur n'a pas d'argument (build/parseScript.c, « legacy compat »).
  const expected = kind === 'main' ? MAIN_TYPES.get(entry.tag) : undefined;
  const tolerated =
    entry.type === RPM_TYPE.STRING && (expected === RPM_TYPE.I18NSTRING || expected === RPM_TYPE.STRING_ARRAY);
  if (expected !== undefined && expected !== entry.type && !tolerated) {
    throw invalid(`tag ${entry.tag} de type ${entry.type} au lieu de ${expected}`);
  }
  if (entry.type === RPM_TYPE.I18NSTRING && entry.count !== 1) throw invalid('chaîne traduite en plusieurs langues');
  if (entry.tag === REGION.I18NTABLE && (entry.type !== RPM_TYPE.STRING_ARRAY || entry.count !== 1)) {
    throw invalid('table de traductions');
  }
}

/** dataLength sur disque : chaînes terminées par NUL avant le trailer de région, sinon taille x nombre. */
function dataLength(type: number, data: Uint8Array, offset: number, count: number): number {
  if (type === RPM_TYPE.STRING && count !== 1) throw invalid('chaîne à plusieurs éléments');
  if (STRING_CLASS.has(type)) {
    let position = offset;
    for (let index = 0; index < count; index += 1) {
      const nul = data.indexOf(0, position);
      if (nul < 0) throw invalid('chaîne non terminée');
      position = nul + 1;
    }
    return position - offset;
  }
  return at(TYPE_SIZES, type) * count;
}

function accessors(bytes: Uint8Array, entries: ReadonlyMap<number, Entry>): RpmHeader {
  const numbers = (tag: number, type: number, size: number): number[] => {
    const entry = entries.get(tag);
    if (entry === undefined) return [];
    if (entry.type !== type) throw invalid(`tag ${tag} de type ${entry.type} au lieu de ${type}`);
    const view = new DataView(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
    return Array.from({ length: entry.count }, (_, index) => readNumber(view, index * size, size));
  };
  const strings = (tag: number, types: readonly number[]): string[] => {
    const entry = entries.get(tag);
    if (entry === undefined) return [];
    if (!types.includes(entry.type)) throw invalid(`tag ${tag} de type ${entry.type} au lieu de ${types.join(' ou ')}`);
    return [...entry.strings];
  };
  return {
    bytes,
    byteLength: bytes.length,
    has: (tag) => entries.has(tag),
    string: (tag) => strings(tag, [RPM_TYPE.STRING, RPM_TYPE.I18NSTRING])[0],
    strings: (tag) => strings(tag, [RPM_TYPE.STRING_ARRAY, RPM_TYPE.STRING]),
    uint16: (tag) => numbers(tag, RPM_TYPE.INT16, 2),
    uint32: (tag) => numbers(tag, RPM_TYPE.INT32, 4),
    uint64: (tag) => numbers(tag, RPM_TYPE.INT64, 8),
  };
}

function readNumber(view: DataView, offset: number, size: number): number {
  if (size === 2) return view.getUint16(offset);
  if (size === 4) return view.getUint32(offset);
  const value = view.getBigUint64(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid('entier hors limites');
  return Number(value);
}

function decode(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw invalid('UTF-8 invalide');
  }
}
