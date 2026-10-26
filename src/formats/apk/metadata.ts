// Métadonnées d'un .apk lues dans .PKGINFO : identité (pkgname, pkgver, arch), origine (paquet
// source), relations (depend, provides, replaces), datahash. Les champs republiés plus tard dans
// l'APKINDEX (M5) sont validés ici.

import type { Relation } from '../../domain/package.js';
import { FormatError } from '../common/errors.js';
import { type PkgInfo, parseApkDependencies } from './pkginfo.js';
import { isValidApkVersion } from './version.js';

export interface ApkMetadata {
  readonly name: string;
  readonly version: string;
  readonly arch: string;
  readonly sourceName: string;
  readonly sourceVersion: string;
  readonly depends: readonly (readonly Relation[])[];
  readonly provides: readonly Relation[];
  readonly conflicts: readonly Relation[];
  readonly replaces: readonly Relation[];
  readonly datahash: string;
  readonly control: Readonly<Record<string, string>>;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const ARCH = /^[a-z0-9_]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const NUMBER = /^\d{1,15}$/;
const NUMERIC_KEYS = ['size', 'builddate', 'provider_priority', 'replaces_priority'];

const invalid = (reason: string): FormatError => new FormatError('FORMAT_INVALID', `.PKGINFO : ${reason}`);

export function readApkMetadata(info: PkgInfo): ApkMetadata {
  const name = required(info, 'pkgname', NAME);
  const version = required(info, 'pkgver');
  if (!isValidApkVersion(version)) throw invalid('pkgver');
  const arch = required(info, 'arch', ARCH);
  const datahash = required(info, 'datahash', SHA256_HEX);
  for (const key of NUMERIC_KEYS) {
    const value = info.get(key);
    if (value !== undefined && !NUMBER.test(value)) throw invalid(key);
  }
  const origin = info.get('origin');
  if (origin !== undefined && !NAME.test(origin)) throw invalid('origin');
  const { depends, conflicts } = parseApkDependencies(info.all('depend'));
  const provides = parseApkDependencies(info.all('provides'));
  const replaces = parseApkDependencies(info.all('replaces'));
  if (
    provides.conflicts.length > 0 ||
    provides.depends.some(({ operator }) => operator !== undefined && operator !== 'eq')
  ) {
    throw invalid('provides');
  }
  if (replaces.conflicts.length > 0 || replaces.depends.some(({ operator }) => operator !== undefined)) {
    throw invalid('replaces');
  }
  // install_if (installation automatique, signal SEC-02) : syntaxe validée, valeur gardée brute dans control.
  parseApkDependencies(info.all('install_if'));
  return {
    name,
    version,
    arch,
    sourceName: origin ?? name,
    sourceVersion: version,
    depends: depends.map((relation) => [relation]),
    provides: provides.depends,
    conflicts,
    replaces: replaces.depends,
    datahash,
    control: control(info),
  };
}

function required(info: PkgInfo, key: string, pattern?: RegExp): string {
  const value = info.get(key);
  if (value === undefined || (pattern !== undefined && !pattern.test(value)))
    throw invalid(`${key} absent ou invalide`);
  return value;
}

/** Champs bruts, une valeur par clé ; les clés répétables sont jointes par une espace (format APKINDEX). */
function control(info: PkgInfo): Record<string, string> {
  const fields = new Map<string, string[]>();
  for (const [key, value] of info.entries) fields.set(key, [...(fields.get(key) ?? []), value]);
  return Object.fromEntries([...fields].map(([key, values]) => [key, values.join(' ')]));
}
