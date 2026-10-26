// Format .apk v2 : lecture complète (membres, signatures, contrôle, .PKGINFO, datahash vérifié,
// identifiant C:) et flux internes pour l'antivirus (SEC-01) : contrôle puis données décompressés.

import { createHash } from 'node:crypto';
import type { ParsedPackage } from '../../domain/package.js';
import { decompress } from '../common/decompress.js';
import { computeDigestsWithTail } from '../common/digests.js';
import { FormatError } from '../common/errors.js';
import { decompressionBudget } from '../common/limits.js';
import type { ByteSource } from '../common/source.js';
import type { InnerStream, PackageFormat, ParseOptions } from '../package-format.js';
import { APK_SCRIPTS, readApkLayout } from './layout.js';
import { readApkMetadata } from './metadata.js';
import { parsePkgInfo } from './pkginfo.js';
import { compareApkVersion } from './version.js';

export async function parseApk(source: ByteSource, options: ParseOptions): Promise<ParsedPackage> {
  const layout = await readApkLayout(source, options);
  const info = parsePkgInfo(layout.pkginfo, options.limits);
  const { datahash, ...metadata } = readApkMetadata(info);
  const controlBytes = await source.read(layout.control.offset, layout.control.length, options.signal);
  const { digests, tailSha256 } = await computeDigestsWithTail(source, layout.dataStart, options.signal);
  if (tailSha256 !== datahash) throw new FormatError('FORMAT_INVALID', 'paquet APK : datahash faux');
  return {
    format: 'apk',
    ...metadata,
    size: source.size,
    digests,
    maintainerScripts: APK_SCRIPTS.filter((script) => layout.controlFiles.has(script)),
    indexChecksum: `Q1${createHash('sha1').update(controlBytes).digest('base64')}`,
    signatures: layout.signatures,
  };
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

export async function* apkInnerStreams(source: ByteSource, options: ParseOptions): AsyncGenerator<InnerStream> {
  const layout = await readApkLayout(source, options);
  yield { name: 'control.tar', data: once(layout.control.data) };
  const size = source.size - layout.dataStart;
  yield {
    name: 'data.tar',
    data: decompress(source.stream(layout.dataStart, size, options.signal), 'gzip', {
      maxOutputBytes: decompressionBudget(options.limits, size, Number.POSITIVE_INFINITY),
      limits: options.limits,
      signal: options.signal,
    }),
  };
}

export const apkFormat = {
  name: 'apk',
  parse: parseApk,
  innerStreams: apkInnerStreams,
  compareVersions: compareApkVersion,
} satisfies PackageFormat;
