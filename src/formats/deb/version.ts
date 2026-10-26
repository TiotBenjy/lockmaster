// Versions Debian : `[epoch:]upstream_version[-debian_revision]` (deb-version(7), Debian Policy
// §5.6.12). Comparaison écrite d'après l'algorithme de deb-version(7) (« Sorting algorithm ») :
// alternance de parties non numériques, comparées avec `~` avant tout, puis la fin, puis les
// lettres, puis les autres signes, et de parties numériques comparées par valeur.

import { FormatError } from '../common/errors.js';

export interface DebVersion {
  readonly epoch: number;
  readonly upstream: string;
  /** Vide si absente ; l'absence se compare comme une révision « 0 ». */
  readonly revision: string;
}

const MAX_EPOCH = 2_147_483_647;
const EPOCH = /^\d+$/;
const UPSTREAM_WITH_EPOCH = /^\d[A-Za-z0-9.+~:-]*$/;
const UPSTREAM = /^\d[A-Za-z0-9.+~-]*$/;
const REVISION = /^[A-Za-z0-9.+~]+$/;

const invalid = (): FormatError => new FormatError('FORMAT_INVALID', 'version Debian invalide');

export function parseDebVersion(value: string): DebVersion {
  const colon = value.indexOf(':');
  let epoch = 0;
  let rest = value;
  if (colon >= 0) {
    const text = value.slice(0, colon);
    if (!EPOCH.test(text) || text.length > 10) throw invalid();
    epoch = Number(text);
    if (epoch > MAX_EPOCH) throw invalid();
    rest = value.slice(colon + 1);
  }
  const dash = rest.lastIndexOf('-');
  const upstream = dash >= 0 ? rest.slice(0, dash) : rest;
  const revision = dash >= 0 ? rest.slice(dash + 1) : '';
  if (!(colon >= 0 ? UPSTREAM_WITH_EPOCH : UPSTREAM).test(upstream)) throw invalid();
  if (dash >= 0 && !REVISION.test(revision)) throw invalid();
  return { epoch, upstream, revision };
}

/** Négatif, nul ou positif selon que `a` est antérieure, égale ou postérieure à `b`. */
export function compareDebVersion(a: string, b: string): number {
  const left = parseDebVersion(a);
  const right = parseDebVersion(b);
  if (left.epoch !== right.epoch) return left.epoch - right.epoch;
  return compareParts(left.upstream, right.upstream) || compareParts(left.revision, right.revision);
}

/** Poids d'un caractère dans une partie non numérique ; la fin de chaîne et un chiffre pèsent 0. */
function order(code: number | undefined): number {
  if (code === undefined || isDigit(code)) return 0;
  if (code === 0x7e) return -1;
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return code;
  return code + 256;
}

const isDigit = (code: number | undefined): boolean => code !== undefined && code >= 0x30 && code <= 0x39;

function compareParts(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    while ((i < a.length && !isDigit(a.charCodeAt(i))) || (j < b.length && !isDigit(b.charCodeAt(j)))) {
      const diff =
        order(i < a.length ? a.charCodeAt(i) : undefined) - order(j < b.length ? b.charCodeAt(j) : undefined);
      if (diff !== 0) return diff;
      i += 1;
      j += 1;
    }
    while (a.charCodeAt(i) === 0x30) i += 1;
    while (b.charCodeAt(j) === 0x30) j += 1;
    let firstDiff = 0;
    while (isDigit(a.charCodeAt(i)) && isDigit(b.charCodeAt(j))) {
      if (firstDiff === 0) firstDiff = a.charCodeAt(i) - b.charCodeAt(j);
      i += 1;
      j += 1;
    }
    if (isDigit(a.charCodeAt(i))) return 1;
    if (isDigit(b.charCodeAt(j))) return -1;
    if (firstDiff !== 0) return firstDiff;
  }
  return 0;
}
