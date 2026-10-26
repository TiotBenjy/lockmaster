// Format .rpm : lecture complète (lead, signature, en-tête principal, métadonnées, empreintes dont
// celle du payload, PAYLOADDIGEST) et flux internes pour l'antivirus (SEC-01) : l'en-tête, qui
// contient les scriptlets, puis le payload cpio décompressé. Le payload n'est jamais extrait.

import type { ParsedPackage } from '../../domain/package.js';
import { type Compression, decompress } from '../common/decompress.js';
import { computeDigestsWithTail } from '../common/digests.js';
import { FormatError } from '../common/errors.js';
import { decompressionBudget } from '../common/limits.js';
import type { ByteSource } from '../common/source.js';
import type { InnerStream, PackageFormat, ParseOptions } from '../package-format.js';
import { readRpmLayout } from './layout.js';
import { readRpmMetadata } from './metadata.js';
import { TAG } from './tags.js';
import { compareRpmEvr } from './version.js';

/** PGPHASHALGO_SHA256 (RFC 4880 §9.4), seul algorithme écrit par rpmbuild dans PAYLOADDIGESTALGO. */
const SHA256_ALGORITHM = 8;

export async function parseRpm(source: ByteSource, options: ParseOptions): Promise<ParsedPackage> {
  const layout = await readRpmLayout(source, options);
  const { compression: _compression, ...metadata } = readRpmMetadata(layout.header, options.limits);
  const { digests, tailSha256 } = await computeDigestsWithTail(source, layout.headerEnd, options.signal);
  checkPayloadDigest(layout.header.strings(TAG.PAYLOADDIGEST), layout.header.uint32(TAG.PAYLOADDIGESTALGO), tailSha256);
  return {
    format: 'rpm',
    ...metadata,
    size: source.size,
    digests,
    headerRange: { start: layout.headerStart, end: layout.headerEnd },
  };
}

function checkPayloadDigest(expected: readonly string[], algorithms: readonly number[], actual: string): void {
  if (expected.length === 0 && algorithms.length === 0) return;
  if (algorithms.length !== 1 || algorithms[0] !== SHA256_ALGORITHM) {
    throw new FormatError('FORMAT_INVALID', 'paquet RPM : algorithme de PAYLOADDIGEST non pris en charge');
  }
  if (expected.length !== 1 || expected[0] !== actual) {
    throw new FormatError('FORMAT_INVALID', 'paquet RPM : PAYLOADDIGEST faux');
  }
}

/**
 * Sans PAYLOADCOMPRESSOR, rpm lit le payload en « gzip » (lib/rpmte.c) par zlib, qui laisse passer un
 * flux sans la magie gzip (gzread, mode transparent) : gzip si la magie est présente, sinon aucune.
 */
async function sniffGzip(source: ByteSource, offset: number, options: ParseOptions): Promise<Compression> {
  const magic = await source.read(offset, Math.min(2, source.size - offset), options.signal);
  return magic[0] === 0x1f && magic[1] === 0x8b ? 'gzip' : 'none';
}

export async function* rpmInnerStreams(source: ByteSource, options: ParseOptions): AsyncGenerator<InnerStream> {
  const layout = await readRpmLayout(source, options);
  const { compression } = readRpmMetadata(layout.header, options.limits);
  yield { name: 'header', data: source.stream(layout.headerStart, layout.header.byteLength, options.signal) };
  const size = source.size - layout.headerEnd;
  yield {
    name: 'payload.cpio',
    data: decompress(
      source.stream(layout.headerEnd, size, options.signal),
      compression ?? (await sniffGzip(source, layout.headerEnd, options)),
      {
        maxOutputBytes: decompressionBudget(options.limits, size, Number.POSITIVE_INFINITY),
        limits: options.limits,
        signal: options.signal,
      },
    ),
  };
}

export const rpmFormat = {
  name: 'rpm',
  parse: parseRpm,
  innerStreams: rpmInnerStreams,
  compareVersions: compareRpmEvr,
} satisfies PackageFormat;
