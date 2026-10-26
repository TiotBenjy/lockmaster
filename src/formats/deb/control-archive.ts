// Contenu de control.tar (deb(5), lib/dpkg/dpkg.h, Debian Policy §6) : uniquement des fichiers
// ordinaires à la racine, aux noms connus de dpkg, sans doublon ; aucun lien, aucun sous-dossier.
// Les scripts exécutés à l'installation (preinst, postinst, prerm, postrm, config) et `triggers`
// (qui fait exécuter le postinst d'autres paquets) sont signalés pour la revue (SEC-02).

import { decompress, decompressToBuffer } from '../common/decompress.js';
import { FormatError } from '../common/errors.js';
import { decompressionBudget } from '../common/limits.js';
import type { ByteSource } from '../common/source.js';
import { parseTar, safeRelativePath } from '../common/tar.js';
import type { ParseOptions } from '../package-format.js';
import type { DebMember } from './layout.js';

export const MAINTAINER_SCRIPTS = ['preinst', 'postinst', 'prerm', 'postrm', 'config', 'triggers'] as const;
const DATA_FILES = ['control', 'md5sums', 'conffiles', 'templates', 'shlibs', 'symbols'];
const KNOWN_FILES = new Set<string>([...DATA_FILES, ...MAINTAINER_SCRIPTS]);

export interface ControlArchive {
  readonly control: Uint8Array;
  readonly maintainerScripts: readonly string[];
}

const invalid = (reason: string): FormatError => new FormatError('FORMAT_INVALID', `control.tar : ${reason}`);

/** Flux décompressé et borné de control.tar (aussi envoyé à l'antivirus, SEC-01). */
export function controlTarStream(
  source: ByteSource,
  control: DebMember,
  options: ParseOptions,
): AsyncIterable<Uint8Array> {
  const { member, compression } = control;
  return decompressStream(source, member.offset, member.size, compression, options, options.limits.maxControlBytes);
}

export async function readControlArchive(
  source: ByteSource,
  control: DebMember,
  options: ParseOptions,
): Promise<ControlArchive> {
  const { member, compression } = control;
  const tar = await decompressToBuffer(source.stream(member.offset, member.size, options.signal), compression, {
    maxOutputBytes: decompressionBudget(options.limits, member.size, options.limits.maxControlBytes),
    limits: options.limits,
    signal: options.signal,
  });
  const entries = parseTar(tar, {
    maxEntries: options.limits.maxArchiveEntries,
    maxEntryBytes: options.limits.maxControlBytes,
    maxExtendedHeaderBytes: options.limits.maxFieldBytes,
    requireEndMarker: true,
    signal: options.signal,
  });
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const name = safeRelativePath(entry.path);
    if (name === '' && entry.type === 'directory') continue;
    if (entry.type !== 'file' || !KNOWN_FILES.has(name)) throw invalid('entrée inattendue');
    if (files.has(name)) throw invalid('entrée en double');
    files.set(name, entry.data);
  }
  const controlFile = files.get('control');
  if (controlFile === undefined) throw invalid('fichier control absent');
  return { control: controlFile, maintainerScripts: MAINTAINER_SCRIPTS.filter((script) => files.has(script)) };
}

/** Flux décompressé et borné d'un membre : ratio et plafond de `limits.ts` (SEC-22). */
export async function* decompressStream(
  source: ByteSource,
  offset: number,
  size: number,
  compression: DebMember['compression'],
  options: ParseOptions,
  ceiling: number,
): AsyncGenerator<Uint8Array> {
  yield* decompress(source.stream(offset, size, options.signal), compression, {
    maxOutputBytes: decompressionBudget(options.limits, size, ceiling),
    limits: options.limits,
    signal: options.signal,
  });
}
