import { FormatError } from '../common/errors.js';
import { DEFAULT_LIMITS, type FormatLimits } from '../common/limits.js';
import { parseControl } from './control.js';

// Fichier Release d'un dépôt APT (docs/03 §2.4) : un paragraphe RFC 822 (même lecteur strict que le
// contrôle Debian), limité aux champs que Lockmaster génère. Les sommes de contrôle sont des lignes
// « <hash> <taille> <chemin relatif> » ; les dates suivent le format RFC 2822 en UTC écrit par apt
// (« Sun, 22 Nov 2026 10:00:00 UTC »). Toute autre forme est refusée (FORMAT_INVALID) : ce lecteur sert
// au signataire avant de signer (ADR-0009) et à la vérification des index amont.

export type ChecksumField = 'MD5Sum' | 'SHA1' | 'SHA256' | 'SHA512';

export interface ReleaseChecksum {
  hash: string;
  size: number;
  path: string;
}

export interface ParsedRelease {
  origin: string;
  label: string;
  suite: string;
  date: Date;
  validUntil: Date;
  signedBy: string | undefined;
  checksums: Record<ChecksumField, ReleaseChecksum[]>;
}

const HASH_LENGTH: Record<ChecksumField, number> = { MD5Sum: 32, SHA1: 40, SHA256: 64, SHA512: 128 };
const SINGLE_LINE = [
  'origin',
  'label',
  'suite',
  'codename',
  'version',
  'date',
  'valid-until',
  'architectures',
  'components',
  'description',
  'acquire-by-hash',
  'signed-by',
];
const REQUIRED = ['origin', 'label', 'suite', 'date', 'valid-until', 'sha256'];
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._+~-]*$/;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) UTC$/;

const invalid = (reason: string) => new FormatError('FORMAT_INVALID', `Release : ${reason}`);
const two = (value: number) => String(value).padStart(2, '0');

/** Date au format écrit par apt dans Release (RFC 2822, UTC). */
export function formatReleaseDate(date: Date): string {
  const day = DAYS[date.getUTCDay()] ?? '';
  const month = MONTHS[date.getUTCMonth()] ?? '';
  const time = `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`;
  return `${day}, ${two(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ${time} UTC`;
}

/** Relit une date ; refusée si elle ne se réécrit pas à l'identique (jour de semaine, date impossible). */
function parseDate(value: string, field: string): Date {
  const match = DATE.exec(value);
  const month = match ? MONTHS.indexOf(match[3] ?? '') : -1;
  if (!match || month < 0) throw invalid(`${field} : date mal formée`);
  const [, , day, , year, hours, minutes, seconds] = match.map(Number);
  const date = new Date(Date.UTC(year ?? 0, month, day, hours, minutes, seconds));
  if (formatReleaseDate(date) !== value) throw invalid(`${field} : date impossible`);
  return date;
}

function checksumLines(value: string, field: ChecksumField): ReleaseChecksum[] {
  const [first, ...lines] = value.split('\n');
  if (first !== '' || lines.length === 0) throw invalid(`${field} : liste attendue sur les lignes suivantes`);
  const line = new RegExp(`^ ?([0-9a-f]{${HASH_LENGTH[field]}}) +([0-9]{1,15}) +(\\S+)$`);
  const seen = new Set<string>();
  return lines.map((text) => {
    const match = line.exec(text);
    const path = match?.[3] ?? '';
    if (!match || !path.split('/').every((segment) => SEGMENT.test(segment))) {
      throw invalid(`${field} : ligne de somme de contrôle mal formée`);
    }
    // Un chemin listé deux fois laisserait le client choisir entre deux sommes.
    if (seen.has(path)) throw invalid(`${field} : chemin en double`);
    seen.add(path);
    return { hash: match[1] ?? '', size: Number(match[2]), path };
  });
}

export function parseRelease(text: string, limits: FormatLimits = DEFAULT_LIMITS): ParsedRelease {
  const stanza = parseControl(new TextEncoder().encode(text), limits);
  const names = stanza.fields.map((field) => field.name.toLowerCase());
  const checksumNames = Object.keys(HASH_LENGTH).map((name) => name.toLowerCase());
  for (const name of names) {
    if (!SINGLE_LINE.includes(name) && !checksumNames.includes(name)) throw invalid(`champ inattendu « ${name} »`);
    if (SINGLE_LINE.includes(name) && (stanza.get(name) ?? '').includes('\n'))
      throw invalid(`${name} sur plusieurs lignes`);
  }
  for (const name of REQUIRED) if (!names.includes(name)) throw invalid(`champ « ${name} » absent`);
  const acquireByHash = stanza.get('acquire-by-hash');
  if (acquireByHash !== undefined && acquireByHash !== 'yes') throw invalid('Acquire-By-Hash doit valoir yes');
  const checksums = Object.fromEntries(
    (Object.keys(HASH_LENGTH) as ChecksumField[]).map((field) => {
      const value = stanza.get(field);
      return [field, value === undefined ? [] : checksumLines(value, field)];
    }),
  ) as Record<ChecksumField, ReleaseChecksum[]>;
  return {
    origin: stanza.get('origin') ?? '',
    label: stanza.get('label') ?? '',
    suite: stanza.get('suite') ?? '',
    date: parseDate(stanza.get('date') ?? '', 'Date'),
    validUntil: parseDate(stanza.get('valid-until') ?? '', 'Valid-Until'),
    signedBy: stanza.get('signed-by'),
    checksums,
  };
}
