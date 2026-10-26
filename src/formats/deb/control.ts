// Fichier de contrôle Debian (format RFC 822 de Debian Policy §5.1, deb-control(5)) : un seul
// paragraphe, noms de champ en US-ASCII sans espace ni « : », insensibles à la casse, ne commençant
// ni par « # » ni par « - » ; continuation par une espace ou une tabulation ; ligne vide d'une
// description écrite « . » ; doublons et commentaires (réservés à debian/control) refusés ; UTF-8.

import { FormatError } from '../common/errors.js';
import type { FormatLimits } from '../common/limits.js';

export interface ControlField {
  readonly name: string;
  /** Première ligne sans les blancs qui l'entourent, puis les lignes de continuation telles quelles. */
  readonly value: string;
}

export interface ControlStanza {
  readonly fields: readonly ControlField[];
  /** Valeur d'un champ, nom insensible à la casse. */
  get(name: string): string | undefined;
}

const FIELD_NAME = /^[!-9;-~]+$/;
/** dpkg n'enlève que les espaces et tabulations ; un autre blanc Unicode reste dans la valeur. */
const BLANK_LINE = /^[ \t]*$/;
const OTHER_BLANK_AT_EDGE = /^\s|\s$/u;

/** Retire espaces et tabulations autour d'une valeur ; refuse tout autre blanc à ses bords. */
function trimBlanks(value: string): string {
  const trimmed = value.replace(/^[ \t]+|[ \t]+$/g, '');
  if (OTHER_BLANK_AT_EDGE.test(trimmed)) throw invalid("blanc Unicode autour d'une valeur");
  return trimmed;
}
const utf8 = new TextDecoder('utf-8', { fatal: true });

const invalid = (reason: string): FormatError => new FormatError('FORMAT_INVALID', `contrôle Debian : ${reason}`);

export function parseControl(bytes: Uint8Array, limits: FormatLimits): ControlStanza {
  if (bytes.length > limits.maxControlTextBytes) {
    throw new FormatError('FORMAT_LIMIT_EXCEEDED', `contrôle Debian de plus de ${limits.maxControlTextBytes} octets`);
  }
  const text = decode(bytes);
  const lines = text.split('\n');
  const fields: { name: string; lines: string[] }[] = [];
  let ended = false;
  for (const line of lines) {
    if (BLANK_LINE.test(line)) {
      if (fields.length > 0) ended = true;
      continue;
    }
    if (ended) throw invalid('plusieurs paragraphes');
    if (line.startsWith(' ') || line.startsWith('\t')) {
      const current = fields.at(-1);
      if (current === undefined) throw invalid('continuation sans champ');
      current.lines.push(line);
      continue;
    }
    fields.push({ name: fieldName(line), lines: [trimBlanks(line.slice(line.indexOf(':') + 1))] });
  }
  const result = fields.map(({ name, lines: valueLines }) => ({ name, value: valueLines.join('\n') }));
  checkFields(result, limits);
  const index = new Map(result.map((field) => [field.name.toLowerCase(), field.value]));
  return { fields: result, get: (name) => index.get(name.toLowerCase()) };
}

function decode(bytes: Uint8Array): string {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw invalid('UTF-8 invalide');
  }
  if (hasForbiddenCharacter(text)) throw invalid('caractère de contrôle');
  return text;
}

function fieldName(line: string): string {
  const colon = line.indexOf(':');
  const name = colon < 0 ? '' : line.slice(0, colon);
  if (!FIELD_NAME.test(name) || name.startsWith('#') || name.startsWith('-')) throw invalid('ligne de champ invalide');
  return name;
}

function checkFields(fields: readonly ControlField[], limits: FormatLimits): void {
  const seen = new Set<string>();
  for (const field of fields) {
    const key = field.name.toLowerCase();
    if (seen.has(key)) throw invalid('champ en double');
    seen.add(key);
    if (Buffer.byteLength(field.value) > limits.maxFieldBytes) {
      throw new FormatError('FORMAT_LIMIT_EXCEEDED', `champ de contrôle de plus de ${limits.maxFieldBytes} octets`);
    }
  }
}

/** Contrôles C0 hors tabulation et saut de ligne, DEL et C1 (docs/02 §3.2). */
function hasForbiddenCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Écrit un paragraphe de contrôle. Chaque champ est validé pour qu'aucune valeur ne puisse injecter
 * un autre champ : lignes suivantes commençant par une espace ou une tabulation et non vides.
 */
export function serializeControl(fields: readonly ControlField[]): string {
  return fields.map(serializeField).join('');
}

function serializeField(field: ControlField): string {
  if (!FIELD_NAME.test(field.name) || field.name.startsWith('#') || field.name.startsWith('-')) {
    throw invalid('nom de champ invalide');
  }
  if (hasForbiddenCharacter(field.value)) throw invalid('caractère de contrôle');
  const [first = '', ...rest] = field.value.split('\n');
  if (first !== first.trim()) throw invalid('blancs autour de la première ligne');
  for (const line of rest) {
    if (!(line.startsWith(' ') || line.startsWith('\t')) || BLANK_LINE.test(line))
      throw invalid('ligne de continuation');
  }
  return `${[first === '' ? `${field.name}:` : `${field.name}: ${first}`, ...rest].join('\n')}\n`;
}
