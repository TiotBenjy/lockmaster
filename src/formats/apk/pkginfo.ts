// `.PKGINFO` d'un .apk v2 (apk-package(5) ; lecture d'apk-tools 2.14, src/package.c read_info_line) :
// lignes `clé = valeur`, lignes vides et commentaires `#` ignorés. apk ignore les lignes sans « = »
// et laisse une clé répétée écraser la précédente : ici, ces deux cas sont refusés pour qu'aucune
// lecture ne diffère. Dépendances : `[!]nom[@étiquette][op version]` (apk_blob_pull_dep).

import type { Relation, VersionOperator } from '../../domain/package.js';
import { FormatError } from '../common/errors.js';
import type { FormatLimits } from '../common/limits.js';
import { hasForbiddenCharacter } from '../common/text.js';
import { isValidApkVersion } from './version.js';

export interface PkgInfo {
  readonly entries: readonly (readonly [string, string])[];
  /** Valeur d'une clé à occurrence unique. */
  get(key: string): string | undefined;
  /** Toutes les valeurs d'une clé répétable (depend, provides...). */
  all(key: string): string[];
}

/** Clés que .PKGINFO peut répéter (une valeur par ligne, écrites par abuild). */
const REPEATABLE = new Set(['depend', 'provides', 'replaces', 'install_if', 'triggers']);
const KEY = /^[a-z][a-z0-9_]*$/;
const DEPENDENCY = /^(!?)([^\s<>=~!@]+)(?:@([A-Za-z0-9._-]+))?(?:(<=|>=|<|>|=|~)([^\s<>=~]+))?$/;
const OPERATORS = {
  '<': 'lt',
  '<=': 'le',
  '=': 'eq',
  '>=': 'ge',
  '>': 'gt',
  '~': 'fuzzy',
} as const satisfies Readonly<Record<string, VersionOperator>>;
const utf8 = new TextDecoder('utf-8', { fatal: true });

const invalid = (reason: string): FormatError => new FormatError('FORMAT_INVALID', `.PKGINFO : ${reason}`);

export function parsePkgInfo(bytes: Uint8Array, limits: FormatLimits): PkgInfo {
  if (bytes.length > limits.maxControlTextBytes) {
    throw new FormatError('FORMAT_LIMIT_EXCEEDED', `.PKGINFO de plus de ${limits.maxControlTextBytes} octets`);
  }
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw invalid('UTF-8 invalide');
  }
  const entries: [string, string][] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    if (hasForbiddenCharacter(line)) throw invalid('caractère interdit');
    const separator = line.indexOf(' = ');
    const key = separator < 0 ? '' : line.slice(0, separator);
    if (!KEY.test(key)) throw invalid('ligne sans clé');
    if (!REPEATABLE.has(key) && seen.has(key)) throw invalid('clé répétée');
    seen.add(key);
    entries.push([key, line.slice(separator + 3)]);
  }
  return {
    entries,
    get: (key) => entries.find(([name]) => name === key)?.[1],
    all: (key) => entries.filter(([name]) => name === key).map(([, value]) => value),
  };
}

/** Dépendances (séparées par des blancs) : conflits `!nom` à part. */
export function parseApkDependencies(values: readonly string[]): { depends: Relation[]; conflicts: Relation[] } {
  const depends: Relation[] = [];
  const conflicts: Relation[] = [];
  for (const token of values.flatMap((value) => value.split(/\s+/).filter((part) => part !== ''))) {
    const { conflict, relation } = parseDependency(token);
    (conflict ? conflicts : depends).push(relation);
  }
  return { depends, conflicts };
}

export function parseDependency(token: string): { conflict: boolean; relation: Relation } {
  const match = DEPENDENCY.exec(token);
  if (match === null || hasForbiddenCharacter(token)) throw invalid('dépendance');
  const [, bang, name = '', tag, operatorText, version] = match;
  const relation: { -readonly [K in keyof Relation]: Relation[K] } = { name };
  if (operatorText !== undefined && version !== undefined) {
    if (!isValidApkVersion(version)) throw invalid('version de dépendance');
    relation.operator = OPERATORS[operatorText as keyof typeof OPERATORS];
    relation.version = version;
  }
  if (tag !== undefined) relation.qualifier = tag;
  return { conflict: bang === '!', relation };
}
