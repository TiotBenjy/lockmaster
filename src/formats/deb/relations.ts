// Relations entre paquets Debian (Debian Policy §7.1) : liste séparée par des virgules, alternatives
// `|` seulement dans Depends, Pre-Depends, Recommends et Suggests, opérateurs `<< <= = >= >>` (`<` et
// `>` sont obsolètes et refusés), qualificatif d'architecture `:nom`. Les restrictions `[arch]` et
// les profils `<...>` n'existent que dans les paquets source : refusés dans un paquet binaire.

import type { Relation, RelationGroup, VersionOperator } from '../../domain/package.js';
import { FormatError } from '../common/errors.js';
import { parseDebVersion } from './version.js';

export interface RelationRules {
  readonly alternatives: boolean;
  /** Provides : seul l'opérateur `=` est admis (Policy §7.5). */
  readonly equalOnly?: boolean;
}

const RELATION = /^([a-z0-9][a-z0-9+.-]+)(?::([a-z0-9][a-z0-9-]*))?(?:\s*\(\s*(<<|<=|>=|>>|=)\s*([^\s()]+)\s*\))?$/;
const OPERATORS: Readonly<Record<string, VersionOperator>> = {
  '<<': 'lt',
  '<=': 'le',
  '=': 'eq',
  '>=': 'ge',
  '>>': 'gt',
};

const invalid = (): FormatError => new FormatError('FORMAT_INVALID', 'relation Debian invalide');

export function parseDebRelations(value: string, rules: RelationRules): RelationGroup[] {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '') return [];
  return text.split(',').map((item) => {
    const alternatives = item.split('|');
    if (alternatives.length > 1 && !rules.alternatives) throw invalid();
    return alternatives.map((alternative) => parseRelation(alternative.trim(), rules));
  });
}

function parseRelation(text: string, rules: RelationRules): Relation {
  const match = RELATION.exec(text);
  if (match === null) throw invalid();
  const [, name = '', qualifier, operatorText, version] = match;
  const relation: { -readonly [K in keyof Relation]: Relation[K] } = { name };
  if (qualifier !== undefined) relation.qualifier = qualifier;
  if (operatorText !== undefined && version !== undefined) {
    const operator = OPERATORS[operatorText];
    if (operator === undefined || (rules.equalOnly === true && operator !== 'eq')) throw invalid();
    parseDebVersion(version);
    relation.operator = operator;
    relation.version = version;
  }
  return relation;
}
