// Versions RPM. `rpmvercmp` reproduit le comportement de rpmio/rpmvercmp.c (rpm 4.19) : segments
// alphanumériques comparés un à un, séparateurs ignorés, `~` avant tout (fin comprise), `^` après la
// fin mais avant tout autre segment, segment numérique plus récent qu'un segment alphabétique,
// nombres comparés sans zéros de tête. EVR : epoch absent = 0 (rpmio/rpmver.c), release absente
// inférieure à toute release.

import { FormatError } from '../common/errors.js';

export interface RpmEvr {
  readonly epoch: number;
  readonly version: string;
  /** Vide si absente (dépendances sans release). */
  readonly release: string;
}

/** Caractères admis par rpmbuild dans Version et Release (hors macros, déjà développées). */
const PART = /^[A-Za-z0-9._+~^]+$/;
const EPOCH = /^\d{1,10}$/;
const MAX_EPOCH = 0xffffffff;

const invalid = (): FormatError => new FormatError('FORMAT_INVALID', 'version RPM invalide');

export function parseRpmEvr(value: string): RpmEvr {
  const colon = value.indexOf(':');
  let epoch = 0;
  let rest = value;
  if (colon >= 0) {
    const text = value.slice(0, colon);
    if (!EPOCH.test(text) || Number(text) > MAX_EPOCH) throw invalid();
    epoch = Number(text);
    rest = value.slice(colon + 1);
  }
  const dash = rest.lastIndexOf('-');
  const version = dash >= 0 ? rest.slice(0, dash) : rest;
  const release = dash >= 0 ? rest.slice(dash + 1) : '';
  if (!PART.test(version) || (dash >= 0 && !PART.test(release))) throw invalid();
  return { epoch, version, release };
}

/** EVR écrit comme dans les métadonnées : l'epoch n'apparaît que s'il figure dans l'en-tête. */
export function formatRpmEvr(evr: { epoch: number | undefined; version: string; release: string }): string {
  const base = evr.release === '' ? evr.version : `${evr.version}-${evr.release}`;
  return evr.epoch === undefined ? base : `${evr.epoch}:${base}`;
}

export function compareRpmEvr(a: string, b: string): number {
  const left = parseRpmEvr(a);
  const right = parseRpmEvr(b);
  if (left.epoch !== right.epoch) return left.epoch < right.epoch ? -1 : 1;
  const version = rpmvercmp(left.version, right.version);
  if (version !== 0) return version;
  if (left.release === '' || right.release === '') return Number(left.release !== '') - Number(right.release !== '');
  return rpmvercmp(left.release, right.release);
}

const isDigit = (char: string): boolean => char >= '0' && char <= '9';
const isAlpha = (char: string): boolean => (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');
const isAlnum = (char: string): boolean => isDigit(char) || isAlpha(char);

/** 1 si `a` est plus récente, 0 si égales, -1 si `b` est plus récente. */
export function rpmvercmp(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    while (i < a.length && !isAlnum(a.charAt(i)) && a.charAt(i) !== '~' && a.charAt(i) !== '^') i += 1;
    while (j < b.length && !isAlnum(b.charAt(j)) && b.charAt(j) !== '~' && b.charAt(j) !== '^') j += 1;
    const x = a.charAt(i);
    const y = b.charAt(j);
    if (x === '~' || y === '~') {
      if (x !== '~') return 1;
      if (y !== '~') return -1;
      i += 1;
      j += 1;
      continue;
    }
    if (x === '^' || y === '^') {
      if (x === '') return -1;
      if (y === '') return 1;
      if (x !== '^') return 1;
      if (y !== '^') return -1;
      i += 1;
      j += 1;
      continue;
    }
    if (x === '' || y === '') break;
    const numeric = isDigit(x);
    const matches = numeric ? isDigit : isAlpha;
    let endA = i;
    while (endA < a.length && matches(a.charAt(endA))) endA += 1;
    let endB = j;
    while (endB < b.length && matches(b.charAt(endB))) endB += 1;
    if (endB === j) return numeric ? 1 : -1;
    const result = compareSegments(a.slice(i, endA), b.slice(j, endB), numeric);
    if (result !== 0) return result;
    i = endA;
    j = endB;
  }
  if (i >= a.length && j >= b.length) return 0;
  return i >= a.length ? -1 : 1;
}

function compareSegments(one: string, two: string, numeric: boolean): number {
  let left = one;
  let right = two;
  if (numeric) {
    left = left.replace(/^0+/, '');
    right = right.replace(/^0+/, '');
    if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  }
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
