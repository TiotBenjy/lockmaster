// Champs du fichier control d'un paquet binaire (Debian Policy §5.3 et §5.6) : Package, Version,
// Architecture, Maintainer et Description obligatoires ; noms, versions et architectures validés par
// les règles de la Policy avant tout usage (docs/02 §3.2) ; relations lues selon §7.1.

import type { Relation, RelationGroup } from '../../domain/package.js';
import { FormatError } from '../common/errors.js';
import type { ControlStanza } from './control.js';
import { parseDebRelations, type RelationRules } from './relations.js';
import { parseDebVersion } from './version.js';

export interface DebMetadata {
  readonly name: string;
  readonly version: string;
  readonly arch: string;
  readonly sourceName: string;
  readonly sourceVersion: string;
  readonly depends: readonly RelationGroup[];
  readonly provides: readonly Relation[];
  readonly conflicts: readonly Relation[];
  readonly replaces: readonly Relation[];
}

/** Policy §5.6.7 : minuscules, chiffres, `+ - .`, au moins deux caractères, alphanumérique en tête. */
export const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]+$/;
/** Policy §5.6.8 : un seul mot ; les jokers (`any`, `linux-any`) n'ont pas cours dans un paquet. */
const ARCHITECTURE = /^[a-z0-9][a-z0-9-]*$/;
const SOURCE = /^([a-z0-9][a-z0-9+.-]+)(?: \(([^()\s]+)\))?$/;
const INSTALLED_SIZE = /^\d{1,15}$/;

const invalid = (reason: string): FormatError => new FormatError('FORMAT_INVALID', `contrôle Debian : ${reason}`);

export function readDebMetadata(stanza: ControlStanza): DebMetadata {
  const name = singleLine(stanza, 'Package');
  const version = singleLine(stanza, 'Version');
  const arch = singleLine(stanza, 'Architecture');
  if (!PACKAGE_NAME.test(name)) throw invalid('nom de paquet');
  parseDebVersion(version);
  if (!ARCHITECTURE.test(arch) || arch.split('-').includes('any')) throw invalid('architecture');
  if (singleLine(stanza, 'Maintainer') === '') throw invalid('Maintainer vide');
  if (required(stanza, 'Description').split('\n')[0] === '') throw invalid('Description sans résumé');
  const installedSize = stanza.get('Installed-Size');
  if (installedSize !== undefined && !INSTALLED_SIZE.test(installedSize)) throw invalid('Installed-Size');
  const relation = (field: string, rules: RelationRules) => parseDebRelations(stanza.get(field) ?? '', rules);
  const groups = { alternatives: true };
  const list = { alternatives: false };
  const preDepends = relation('Pre-Depends', groups);
  const depends = relation('Depends', groups);
  relation('Recommends', groups);
  relation('Suggests', groups);
  relation('Enhances', list);
  relation('Built-Using', { alternatives: false, equalOnly: true });
  return {
    name,
    version,
    arch,
    ...readSource(stanza, name, version),
    depends: [...preDepends, ...depends],
    provides: relation('Provides', { alternatives: false, equalOnly: true }).flat(),
    conflicts: [...relation('Conflicts', list), ...relation('Breaks', list)].flat(),
    replaces: relation('Replaces', list).flat(),
  };
}

function required(stanza: ControlStanza, field: string): string {
  const value = stanza.get(field);
  if (value === undefined) throw invalid(`champ ${field} absent`);
  return value;
}

function singleLine(stanza: ControlStanza, field: string): string {
  const value = required(stanza, field);
  if (value.includes('\n')) throw invalid(`champ ${field} sur plusieurs lignes`);
  return value;
}

function readSource(
  stanza: ControlStanza,
  name: string,
  version: string,
): { sourceName: string; sourceVersion: string } {
  const value = stanza.get('Source');
  if (value === undefined) return { sourceName: name, sourceVersion: version };
  const match = SOURCE.exec(value);
  if (match === null) throw invalid('Source');
  const [, sourceName = name, sourceVersion] = match;
  if (sourceVersion !== undefined) parseDebVersion(sourceVersion);
  return { sourceName, sourceVersion: sourceVersion ?? version };
}
