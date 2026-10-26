// Format .deb : lecture complète d'un paquet (structure ar, control.tar, champs de contrôle,
// empreintes) et flux internes décompressés pour l'antivirus (SEC-01). data.tar n'est décompressé
// que pour l'antivirus, jamais pour publier (docs/03 §2.1).

import type { ParsedPackage } from '../../domain/package.js';
import { computeDigests } from '../common/digests.js';
import { throwIfAborted } from '../common/errors.js';
import type { ByteSource } from '../common/source.js';
import type { InnerStream, PackageFormat, ParseOptions } from '../package-format.js';
import { parseControl } from './control.js';
import { controlTarStream, decompressStream, readControlArchive } from './control-archive.js';
import { readDebLayout } from './layout.js';
import { readDebMetadata } from './metadata.js';
import { compareDebVersion } from './version.js';

export async function parseDeb(source: ByteSource, options: ParseOptions): Promise<ParsedPackage> {
  throwIfAborted(options.signal);
  const layout = await readDebLayout(source, options);
  const archive = await readControlArchive(source, layout.control, options);
  const stanza = parseControl(archive.control, options.limits);
  const metadata = readDebMetadata(stanza);
  const digests = await computeDigests(source, options.signal);
  return {
    format: 'deb',
    ...metadata,
    size: source.size,
    digests,
    control: Object.fromEntries(stanza.fields.map((field) => [field.name, field.value])),
    maintainerScripts: archive.maintainerScripts,
  };
}

export async function* debInnerStreams(source: ByteSource, options: ParseOptions): AsyncGenerator<InnerStream> {
  const layout = await readDebLayout(source, options);
  yield { name: 'control.tar', data: controlTarStream(source, layout.control, options) };
  const { member, compression } = layout.data;
  yield {
    name: 'data.tar',
    data: decompressStream(source, member.offset, member.size, compression, options, Number.POSITIVE_INFINITY),
  };
}

export const debFormat = {
  name: 'deb',
  parse: parseDeb,
  innerStreams: debInnerStreams,
  compareVersions: compareDebVersion,
} satisfies PackageFormat;
