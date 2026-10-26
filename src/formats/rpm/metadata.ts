// Métadonnées de l'en-tête principal d'un RPM binaire : identité (NAME, EPOCH, VERSION, RELEASE,
// ARCH), paquet source (SOURCERPM), relations (noms, drapeaux RPMSENSE, versions : include/rpm/rpmds.h),
// fichiers (DIRNAMES, BASENAMES, DIRINDEXES), scriptlets, compression du payload. Tout champ
// republié plus tard (primary.xml) est validé ici.

import type { Relation, VersionOperator } from '../../domain/package.js';
import { atNumber } from '../common/bytes.js';
import { asCompression, type Compression } from '../common/decompress.js';
import { FormatError } from '../common/errors.js';
import type { FormatLimits } from '../common/limits.js';
import { hasForbiddenCharacter } from '../common/text.js';
import type { RpmHeader } from './header.js';
import { SCRIPTLETS, TAG } from './tags.js';
import { formatRpmEvr, parseRpmEvr } from './version.js';

export interface RpmMetadata {
  readonly name: string;
  readonly version: string;
  readonly arch: string;
  readonly sourceName: string;
  readonly sourceVersion: string;
  readonly depends: readonly (readonly Relation[])[];
  readonly provides: readonly Relation[];
  readonly conflicts: readonly Relation[];
  readonly replaces: readonly Relation[];
  readonly files: readonly string[];
  readonly maintainerScripts: readonly string[];
  readonly control: Readonly<Record<string, string>>;
  readonly compression: Compression;
}

const NAME = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/;
const ARCH = /^[A-Za-z0-9_]+$/;
const SOURCE_RPM = /^([A-Za-z0-9_][A-Za-z0-9._+-]*)-([A-Za-z0-9._+~^]+)-([A-Za-z0-9._+~^]+)\.(?:no)?src\.rpm$/;
/** RPMSENSE_LESS (2), GREATER (4), EQUAL (8) ; RPMSENSE_SENSEMASK = 15. */
const SENSES: ReadonlyMap<number, VersionOperator> = new Map([
  [2, 'lt'],
  [10, 'le'],
  [8, 'eq'],
  [12, 'ge'],
  [4, 'gt'],
]);
const SENSE_MASK = 15;
/** Compresseurs écrits par rpmbuild (build/pack.c) ; rpm prend gzip quand le tag est absent (rpmte.c). */
const COMPRESSORS: Readonly<Record<string, string>> = {
  gzip: 'gzip',
  bzip2: 'bzip2',
  xz: 'xz',
  zstd: 'zstd',
  ufdio: 'none',
};

const invalid = (reason: string): FormatError => new FormatError('FORMAT_INVALID', `en-tête RPM : ${reason}`);

export function readRpmMetadata(header: RpmHeader, limits: FormatLimits): RpmMetadata {
  const name = required(header, TAG.NAME, NAME);
  const version = required(header, TAG.VERSION, /^[A-Za-z0-9._+~^]+$/);
  const release = required(header, TAG.RELEASE, /^[A-Za-z0-9._+~^]+$/);
  const arch = required(header, TAG.ARCH, ARCH);
  const epochs = header.uint32(TAG.EPOCH);
  if (epochs.length > 1) throw invalid('EPOCH');
  const epoch = epochs[0];
  const source = SOURCE_RPM.exec(required(header, TAG.SOURCERPM, /^.+$/));
  if (source === null) throw invalid('SOURCERPM');
  return {
    name,
    version: formatRpmEvr({ epoch, version, release }),
    arch,
    sourceName: String(source[1]),
    sourceVersion: `${source[2]}-${source[3]}`,
    depends: relations(header, TAG.REQUIRENAME, TAG.REQUIREFLAGS, TAG.REQUIREVERSION, limits).map((relation) => [
      relation,
    ]),
    provides: relations(header, TAG.PROVIDENAME, TAG.PROVIDEFLAGS, TAG.PROVIDEVERSION, limits),
    conflicts: relations(header, TAG.CONFLICTNAME, TAG.CONFLICTFLAGS, TAG.CONFLICTVERSION, limits),
    replaces: relations(header, TAG.OBSOLETENAME, TAG.OBSOLETEFLAGS, TAG.OBSOLETEVERSION, limits),
    files: files(header, limits),
    maintainerScripts: SCRIPTLETS.filter(([, body, prog]) => header.has(body) || header.has(prog)).map(
      ([label]) => label,
    ),
    control: control(header, { name, epoch, version, release, arch }),
    compression: payloadCompression(header),
  };
}

function required(header: RpmHeader, tag: number, pattern: RegExp): string {
  const value = header.string(tag);
  if (value === undefined || !pattern.test(value)) throw invalid(`tag ${tag} absent ou invalide`);
  return value;
}

/** Noms, drapeaux et versions de même longueur ; opérateur et version présents ensemble. */
function relations(
  header: RpmHeader,
  nameTag: number,
  flagTag: number,
  versionTag: number,
  limits: FormatLimits,
): Relation[] {
  const names = header.strings(nameTag);
  if (names.length === 0) return [];
  const flags = header.uint32(flagTag);
  const versions = header.strings(versionTag);
  if (flags.length !== names.length || versions.length !== names.length) throw invalid('relations incohérentes');
  return names.map((name, index) => {
    if (name === '' || Buffer.byteLength(name) > limits.maxFieldBytes || hasForbiddenCharacter(name)) {
      throw invalid('nom de relation');
    }
    const sense = atNumber(flags, index) & SENSE_MASK;
    const version = String(versions[index]);
    if (sense === 0 && version === '') return { name };
    const operator = SENSES.get(sense);
    if (operator === undefined || version === '') throw invalid('sens de comparaison');
    parseRpmEvr(version);
    return { name, operator, version };
  });
}

function files(header: RpmHeader, limits: FormatLimits): string[] {
  const basenames = header.strings(TAG.BASENAMES);
  const dirnames = header.strings(TAG.DIRNAMES);
  const indexes = header.uint32(TAG.DIRINDEXES);
  if (basenames.length > limits.rpmMaxFiles) {
    throw new FormatError('FORMAT_LIMIT_EXCEEDED', `paquet RPM de plus de ${limits.rpmMaxFiles} fichiers`);
  }
  if (indexes.length !== basenames.length) throw invalid('liste de fichiers incohérente');
  if (!dirnames.every(isCanonicalDirectory)) throw invalid('dossier non canonique');
  return basenames.map((basename, position) => {
    const directory = dirnames[atNumber(indexes, position)];
    if (directory === undefined) throw invalid('indice de dossier hors limites');
    if (!isPlainSegment(basename)) throw invalid('nom de fichier invalide');
    return `${directory}${basename}`;
  });
}

/**
 * Dossier absolu et canonique (`/`, `/usr/bin/`) : un chemin comme `/etc//cron.d/` ou `/etc/./cron.d/`,
 * que rpm installe dans `/etc/cron.d/`, échapperait sinon à l'inventaire des chemins sensibles (M4).
 */
function isCanonicalDirectory(directory: string): boolean {
  if (!directory.startsWith('/') || !directory.endsWith('/')) return false;
  return directory === '/' || directory.slice(1, -1).split('/').every(isPlainSegment);
}

function isPlainSegment(segment: string): boolean {
  return (
    segment !== '' && segment !== '.' && segment !== '..' && !segment.includes('/') && !hasForbiddenCharacter(segment)
  );
}

function control(
  header: RpmHeader,
  identity: { name: string; epoch: number | undefined; version: string; release: string; arch: string },
): Record<string, string> {
  const fields: [string, string | undefined][] = [
    ['Name', identity.name],
    ['Epoch', identity.epoch === undefined ? undefined : String(identity.epoch)],
    ['Version', identity.version],
    ['Release', identity.release],
    ['Arch', identity.arch],
    ['Summary', singleLine(header.string(TAG.SUMMARY))],
    ['Description', text(header.string(TAG.DESCRIPTION))],
    ['License', singleLine(header.string(TAG.LICENSE))],
    ['Group', singleLine(header.string(TAG.GROUP))],
    ['Url', singleLine(header.string(TAG.URL))],
    ['Vendor', singleLine(header.string(TAG.VENDOR))],
    ['Packager', singleLine(header.string(TAG.PACKAGER))],
    ['BuildHost', singleLine(header.string(TAG.BUILDHOST))],
    ['BuildTime', header.uint32(TAG.BUILDTIME)[0]?.toString()],
    ['SourceRpm', header.string(TAG.SOURCERPM)],
    ['InstalledSize', (header.uint64(TAG.LONGSIZE)[0] ?? header.uint32(TAG.SIZE)[0])?.toString()],
  ];
  return Object.fromEntries(fields.filter((field): field is [string, string] => field[1] !== undefined));
}

function payloadCompression(header: RpmHeader): Compression {
  const format = header.string(TAG.PAYLOADFORMAT);
  if (format !== undefined && format !== 'cpio') throw invalid('format de payload autre que cpio');
  const name = header.string(TAG.PAYLOADCOMPRESSOR) ?? 'gzip';
  return asCompression(COMPRESSORS[name] ?? `non admis : ${name.length}`);
}

function singleLine(value: string | undefined): string | undefined {
  if (value !== undefined && hasForbiddenCharacter(value)) throw invalid('texte sur une ligne');
  return value;
}

function text(value: string | undefined): string | undefined {
  if (value !== undefined && hasForbiddenCharacter(value, { newline: true, tab: true })) throw invalid('texte');
  return value;
}
