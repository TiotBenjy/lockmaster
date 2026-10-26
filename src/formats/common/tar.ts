// Lecteur tar en lecture seule et borné (ADR-0015) pour les petites archives déjà décompressées
// (control.tar des .deb, membre de contrôle des .apk). Formats : ustar POSIX.1-1988, pax
// POSIX.1-2001 (en-têtes `x` et `g`), extensions GNU (`L`, `K`, tailles en base 256). Référence :
// POSIX `pax` (IEEE Std 1003.1-2017, section ustar Interchange Format et pax Header Block), GNU tar
// manual « Basic Tar Format ». Aucun fichier n'est créé : les entrées sont rendues en mémoire.

import { at } from './bytes.js';
import { FormatError, throwIfAborted } from './errors.js';

export type TarEntryType = 'file' | 'directory' | 'symlink' | 'hardlink' | 'character-device' | 'block-device' | 'fifo';

export interface TarEntry {
  /** Chemin tel qu'écrit dans l'archive (UTF-8 valide) ; `safeRelativePath` le normalise. */
  readonly path: string;
  readonly type: TarEntryType;
  readonly mode: number;
  readonly size: number;
  readonly linkTarget?: string;
  /** Contenu, pour les fichiers ordinaires. */
  readonly data?: Uint8Array;
}

export interface TarOptions {
  readonly maxEntries: number;
  /** Taille maximale du contenu d'une entrée. */
  readonly maxEntryBytes: number;
  /** Taille maximale d'un en-tête étendu (pax, nom long GNU). */
  readonly maxExtendedHeaderBytes: number;
  /** Exige les deux blocs nuls de fin (faux pour le contrôle apk, écrit sans eux). */
  readonly requireEndMarker: boolean;
  readonly signal?: AbortSignal;
}

const BLOCK = 512;
const TYPES: Readonly<Record<string, TarEntryType>> = {
  '0': 'file',
  '\0': 'file',
  '7': 'file',
  '1': 'hardlink',
  '2': 'symlink',
  '3': 'character-device',
  '4': 'block-device',
  '5': 'directory',
  '6': 'fifo',
};
const EXTENDED = new Set(['x', 'g', 'L', 'K']);
/**
 * Clés pax admises : celles qui changent nom, cible ou taille sont contrôlées (`reconcile`), les autres
 * sont des métadonnées sans effet sur le contenu. Toute autre clé (GNU.sparse.*, hdrcharset,
 * SCHILY.xattr.*...) pourrait changer ce qu'un autre lecteur extrait : refusée.
 */
const PAX_CONTROLLED_KEYS = new Set(['path', 'linkpath', 'size']);
const PAX_METADATA_KEYS = new Set(['mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'comment']);
const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Surcharges en attente pour l'entrée suivante (pax `x`, GNU `L` / `K`). Pour qu'un lecteur qui les
 * ignore et un lecteur qui les applique voient la même archive, elles doivent concorder avec
 * l'en-tête ustar de l'entrée (voir `reconcile`) ; la taille vient toujours de l'en-tête ustar.
 */
interface Pending {
  readonly kinds: ReadonlySet<string>;
  readonly path?: string;
  readonly linkTarget?: string;
  readonly size?: number;
}

const NO_PENDING: Pending = { kinds: new Set() };

export function parseTar(bytes: Uint8Array, options: TarOptions): TarEntry[] {
  const entries: TarEntry[] = [];
  let pending = NO_PENDING;
  let offset = 0;
  for (;;) {
    throwIfAborted(options.signal);
    if (offset === bytes.length && !options.requireEndMarker && pending.kinds.size === 0) return entries;
    const header = block(bytes, offset);
    if (header.every((byte) => byte === 0)) {
      if (pending.kinds.size > 0) throw invalid(offset, 'en-tête étendu sans entrée');
      checkEnd(bytes, offset, options.requireEndMarker);
      return entries;
    }
    const raw = readHeader(header, offset);
    const dataEnd = offset + BLOCK + raw.size;
    if (dataEnd > bytes.length) throw new FormatError('FORMAT_TRUNCATED', `tar : données tronquées à ${offset}`);
    const data = bytes.subarray(offset + BLOCK, dataEnd);
    offset = offset + BLOCK + Math.ceil(raw.size / BLOCK) * BLOCK;
    if (EXTENDED.has(raw.typeflag)) {
      pending = applyExtended(pending, raw.typeflag, data, options, offset);
      continue;
    }
    if (entries.length >= options.maxEntries) {
      throw new FormatError('FORMAT_LIMIT_EXCEEDED', `tar : plus de ${options.maxEntries} entrées`);
    }
    entries.push(buildEntry(raw, pending, data, options));
    pending = NO_PENDING;
  }
}

interface RawHeader {
  readonly path: string;
  readonly linkTarget: string;
  /** Champ ustar rempli sur toute sa longueur : il peut tronquer un chemin long (pax ou GNU). */
  readonly pathFieldFull: boolean;
  readonly linkFieldFull: boolean;
  readonly typeflag: string;
  readonly mode: number;
  readonly size: number;
}

/** Après le premier bloc nul : rien d'autre que des zéros (pas d'entrée cachée derrière la fin). */
function checkEnd(bytes: Uint8Array, offset: number, requireEndMarker: boolean): void {
  if (requireEndMarker) block(bytes, offset + BLOCK);
  for (let index = offset; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) throw invalid(offset, "données après la fin de l'archive");
  }
}

function block(bytes: Uint8Array, offset: number): Uint8Array {
  if (offset + BLOCK > bytes.length) throw new FormatError('FORMAT_TRUNCATED', `tar : bloc tronqué à ${offset}`);
  return bytes.subarray(offset, offset + BLOCK);
}

function readHeader(header: Uint8Array, offset: number): RawHeader {
  const magic = latin1(header.subarray(257, 265));
  const posix = magic === 'ustar\u000000';
  if (!posix && magic !== 'ustar  \0') throw invalid(offset, 'magie ustar absente');
  if (!checksumMatches(header)) throw invalid(offset, 'somme de contrôle fausse');
  const name = text(header.subarray(0, 100), offset);
  const prefix = posix ? text(header.subarray(345, 500), offset) : '';
  return {
    path: prefix === '' ? name : `${prefix}/${name}`,
    linkTarget: text(header.subarray(157, 257), offset),
    pathFieldFull: !header.subarray(0, 100).includes(0),
    linkFieldFull: !header.subarray(157, 257).includes(0),
    typeflag: String.fromCharCode(at(header, 156)),
    mode: octalNumber(header.subarray(100, 108), offset) & 0o7777,
    size: sizeField(header.subarray(124, 136), offset),
  };
}

function buildEntry(raw: RawHeader, pending: Pending, data: Uint8Array, options: TarOptions): TarEntry {
  const type = TYPES[raw.typeflag];
  if (type === undefined) throw invalid(-1, "type d'entrée non pris en charge");
  if (pending.size !== undefined && pending.size !== raw.size) throw invalid(-1, 'taille pax différente de ustar');
  const path = reconcile(pending.path, raw.path, raw.pathFieldFull);
  if (path === '') throw invalid(-1, 'chemin vide');
  if (type !== 'file') {
    if (data.length > 0) throw invalid(-1, "données sur une entrée qui n'en a pas");
    const linkTarget = reconcile(pending.linkTarget, raw.linkTarget, raw.linkFieldFull);
    const isLink = type === 'symlink' || type === 'hardlink';
    return isLink ? { path, type, mode: raw.mode, size: 0, linkTarget } : { path, type, mode: raw.mode, size: 0 };
  }
  if (data.length > options.maxEntryBytes) {
    throw new FormatError('FORMAT_LIMIT_EXCEEDED', `tar : entrée de plus de ${options.maxEntryBytes} octets`);
  }
  return { path, type, mode: raw.mode, size: data.length, data: data.slice() };
}

/**
 * Chemin étendu (pax, GNU) et chemin ustar doivent concorder : égaux, ou le champ ustar plein en
 * est le début (troncature écrite par GNU tar). Sinon un lecteur qui ignore l'extension verrait un
 * autre nom (par exemple `./postinst`) que celui retenu ici.
 */
function reconcile(extended: string | undefined, ustar: string, fieldFull: boolean): string {
  if (extended === undefined || extended === ustar) return ustar;
  if (fieldFull && isCanonical(ustar) && extended.startsWith(ustar)) return extended;
  throw invalid(-1, 'chemin étendu différent du nom ustar');
}

/**
 * Nom tronqué sans segment vide ni `.` (hors `./` initial) : sa forme normalisée garde presque tous
 * ses caractères, donc un lecteur qui ignore l'extension ne peut pas y lire un nom court.
 */
function isCanonical(path: string): boolean {
  const body = path.startsWith('./') ? path.slice(2) : path;
  const segments = body.split('/');
  return segments.every((segment, index) => segment !== '.' && (segment !== '' || index === segments.length - 1));
}

function applyExtended(
  pending: Pending,
  typeflag: string,
  data: Uint8Array,
  options: TarOptions,
  offset: number,
): Pending {
  if (data.length > options.maxExtendedHeaderBytes) {
    throw new FormatError(
      'FORMAT_LIMIT_EXCEEDED',
      `tar : en-tête étendu de plus de ${options.maxExtendedHeaderBytes} octets`,
    );
  }
  if (typeflag === 'g') {
    const global = parsePax(data, offset);
    if (pending.kinds.size > 0 || Object.keys(global).length > 0) throw invalid(offset, 'en-tête pax global inattendu');
    return pending;
  }
  if (pending.kinds.has(typeflag)) throw invalid(offset, 'en-tête étendu répété');
  const kinds = new Set([...pending.kinds, typeflag]);
  const values: PaxValues =
    typeflag === 'L'
      ? { path: text(data, offset) }
      : typeflag === 'K'
        ? { linkTarget: text(data, offset) }
        : parsePax(data, offset);
  if (
    (values.path !== undefined && pending.path !== undefined) ||
    (values.linkTarget !== undefined && pending.linkTarget !== undefined)
  ) {
    throw invalid(offset, 'deux en-têtes étendus pour le même chemin');
  }
  return { ...pending, ...values, kinds };
}

interface PaxValues {
  path?: string;
  linkTarget?: string;
  size?: number;
}

/** Enregistrements pax `"<longueur> <clé>=<valeur>\n"` ; seules path, linkpath et size servent. */
function parsePax(data: Uint8Array, offset: number): PaxValues {
  const result: PaxValues = {};
  let position = 0;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    const length = space > position ? decimal(latin1(data.subarray(position, space))) : Number.NaN;
    const end = position + length;
    if (!Number.isSafeInteger(length) || end > data.length || data[end - 1] !== 0x0a) {
      throw invalid(offset, 'enregistrement pax mal formé');
    }
    const record = text(data.subarray(space + 1, end - 1), offset, false);
    const equals = record.indexOf('=');
    if (equals <= 0) throw invalid(offset, 'enregistrement pax sans clé');
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (!PAX_CONTROLLED_KEYS.has(key) && !PAX_METADATA_KEYS.has(key)) throw invalid(offset, 'clé pax non admise');
    if (key === 'path') result.path = value;
    else if (key === 'linkpath') result.linkTarget = value;
    else if (key === 'size') result.size = decimalOrThrow(value, offset);
    position = end;
  }
  return result;
}

function checksumMatches(header: Uint8Array): boolean {
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : at(header, index);
    unsigned += byte;
    signed += byte > 0x7f ? byte - 0x100 : byte;
  }
  const stored = octalNumber(header.subarray(148, 156), -1);
  return stored === unsigned || stored === signed;
}

/** Taille : octal ASCII, ou base 256 (premier octet 0x80, extension GNU) pour les gros fichiers. */
function sizeField(field: Uint8Array, offset: number): number {
  if (field[0] !== 0x80) return octalNumber(field, offset);
  let value = 0;
  for (const byte of field.subarray(1)) value = value * 256 + byte;
  if (!Number.isSafeInteger(value)) throw invalid(offset, 'taille hors limites');
  return value;
}

function octalNumber(field: Uint8Array, offset: number): number {
  const digits = latin1(field)
    .replace(/[\0 ]+$/, '')
    .replace(/^ +/, '');
  if (!/^[0-7]{1,12}$/.test(digits)) throw invalid(offset, 'champ numérique non octal');
  return Number.parseInt(digits, 8);
}

function decimal(value: string): number {
  return /^\d{1,15}$/.test(value) ? Number.parseInt(value, 10) : Number.NaN;
}

function decimalOrThrow(value: string, offset: number): number {
  const parsed = decimal(value);
  if (Number.isNaN(parsed)) throw invalid(offset, 'taille pax non décimale');
  return parsed;
}

/** Texte UTF-8 strict, coupé au premier octet nul pour les champs d'en-tête. */
function text(field: Uint8Array, offset: number, nulTerminated = true): string {
  const nul = nulTerminated ? field.indexOf(0) : -1;
  const content = nul >= 0 ? field.subarray(0, nul) : field;
  if (!nulTerminated && content.includes(0)) throw invalid(offset, 'octet nul dans un enregistrement pax');
  try {
    return utf8.decode(content);
  } catch {
    throw invalid(offset, 'texte UTF-8 invalide');
  }
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
}

function invalid(offset: number, reason: string): FormatError {
  return new FormatError('FORMAT_INVALID', offset >= 0 ? `tar : ${reason} (à ${offset})` : `tar : ${reason}`);
}

/**
 * Chemin relatif sûr : retire les `./` et les `/` redondants, refuse chemin absolu, `..`,
 * barre oblique inverse et caractères de contrôle. Rend '' pour la racine de l'archive.
 */
export function safeRelativePath(path: string): string {
  if (path.startsWith('/') || path.includes('\\') || hasControlCharacter(path) || BIDI_CONTROLS.test(path)) {
    throw invalid(-1, 'chemin interdit');
  }
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) throw invalid(-1, 'chemin interdit');
  return segments.join('/');
}

/** Contrôles C0, DEL et C1 (docs/02 §3.2). */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Marques de direction (U+200E, U+200F, U+202A à U+202E, U+2066 à U+2069) : un nom affiché trompeur. */
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
