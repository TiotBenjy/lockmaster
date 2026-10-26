// Structure d'un .apk v2 (apk-v2(5) ; apk-tools 2.14, src/package.c apk_sign_ctx_process_file) :
// membres gzip concaténés, [signature] + contrôle + données. apk lit l'ensemble comme un seul flux tar :
// les entrées `.SIGN.*` d'abord, puis le contrôle (fichiers à point initial, sans `/`), puis les
// données ; les frontières de membres ne servent qu'aux empreintes. Ici chaque membre doit contenir
// exactement sa partie, pour que notre lecture et celle d'apk coïncident.

import { FormatError, throwIfAborted } from '../common/errors.js';
import { type GzipMember, readGzipMember } from '../common/gzip-member.js';
import type { ByteSource } from '../common/source.js';
import { parseTar, type TarEntry } from '../common/tar.js';
import type { ParseOptions } from '../package-format.js';

export interface ApkSignature {
  readonly algorithm: string;
  readonly keyName: string;
}

export interface ApkLayout {
  readonly signatures: readonly ApkSignature[];
  /** Membre contrôle (ses octets compressés donnent l'identifiant C:). */
  readonly control: GzipMember;
  readonly controlFiles: ReadonlyMap<string, Uint8Array>;
  readonly pkginfo: Uint8Array;
  /** Début du membre données : datahash couvre tout le reste du fichier. */
  readonly dataStart: number;
}

/** Scripts exécutés par apk, dans l'ordre de apk_script_types (src/package.c) ; seul autre fichier : `.PKGINFO`. */
export const APK_SCRIPTS = [
  '.pre-install',
  '.post-install',
  '.pre-deinstall',
  '.post-deinstall',
  '.pre-upgrade',
  '.post-upgrade',
  '.trigger',
] as const;
const CONTROL_FILES = new Set<string>(['.PKGINFO', ...APK_SCRIPTS]);
/** Types de signature reconnus par apk 2.14 ; le nom de clé devient un nom de fichier sous /etc/apk/keys. */
const SIGNATURE = /^\.SIGN\.(RSA512|RSA256|RSA|DSA)\.([A-Za-z0-9][A-Za-z0-9._@+-]*)$/;
/** apk ignore une signature plus grande (apk_sign_ctx_process_file). */
const MAX_SIGNATURE_BYTES = 65_536;

const invalid = (reason: string): FormatError => new FormatError('FORMAT_INVALID', `paquet APK : ${reason}`);

export async function readApkLayout(source: ByteSource, options: ParseOptions): Promise<ApkLayout> {
  throwIfAborted(options.signal);
  if (source.size > options.limits.maxPackageBytes) {
    throw new FormatError('FORMAT_LIMIT_EXCEEDED', `paquet de plus de ${options.limits.maxPackageBytes} octets`);
  }
  const first = await readMember(source, 0, options);
  let signatures: ApkSignature[] = [];
  let control = first;
  if (first.entries.length > 0 && first.entries.every((entry) => entry.path.startsWith('.SIGN.'))) {
    signatures = first.entries.map(readSignature);
    control = await readMember(source, first.member.length, options);
  }
  const controlFiles = readControlFiles(control.entries);
  const pkginfo = controlFiles.get('.PKGINFO');
  if (pkginfo === undefined) throw invalid('.PKGINFO absent');
  const dataStart = control.member.offset + control.member.length;
  if (dataStart >= source.size) throw new FormatError('FORMAT_TRUNCATED', 'paquet APK sans données');
  return { signatures, control: control.member, controlFiles, pkginfo, dataStart };
}

async function readMember(source: ByteSource, offset: number, options: ParseOptions) {
  const member = await readGzipMember(source, offset, {
    maxOutputBytes: options.limits.maxControlBytes,
    signal: options.signal,
  });
  const entries = parseTar(member.data, {
    maxEntries: options.limits.maxArchiveEntries,
    maxEntryBytes: options.limits.maxControlBytes,
    maxExtendedHeaderBytes: options.limits.maxFieldBytes,
    requireEndMarker: false,
    signal: options.signal,
  });
  return { member, entries };
}

function readSignature(entry: TarEntry): ApkSignature {
  const match = SIGNATURE.exec(entry.path);
  if (match === null || entry.type !== 'file' || entry.size > MAX_SIGNATURE_BYTES) throw invalid('signature');
  return { algorithm: String(match[1]), keyName: String(match[2]) };
}

/** Noms exacts (apk compare `.PKGINFO` à la lettre ; `./.PKGINFO` serait un fichier de données). */
function readControlFiles(entries: readonly TarEntry[]): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (entry.type !== 'file' || !CONTROL_FILES.has(entry.path)) throw invalid('entrée de contrôle inattendue');
    if (files.has(entry.path)) throw invalid('entrée de contrôle en double');
    files.set(entry.path, entry.data);
  }
  return files;
}
