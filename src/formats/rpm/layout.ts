// Structure d'un .rpm v4 (lib/rpmlead.c, lib/package.c, lib/header.c de rpm 4.19) : lead de 96 octets
// (magie ED AB EE DB, version 3, type 0 = binaire, type de signature 5 = en-tête), en-tête de
// signature complété à un multiple de 8 octets, en-tête principal, payload jusqu'à la fin du fichier.

import { createHash } from 'node:crypto';
import { FormatError, throwIfAborted } from '../common/errors.js';
import type { ByteSource } from '../common/source.js';
import type { ParseOptions } from '../package-format.js';
import { headerLength, parseRpmHeader, type RpmHeader } from './header.js';
import { SIG } from './tags.js';

export interface RpmLayout {
  readonly signature: RpmHeader;
  readonly header: RpmHeader;
  readonly headerStart: number;
  readonly headerEnd: number;
}

const LEAD_BYTES = 96;
const LEAD_MAGIC = [0xed, 0xab, 0xee, 0xdb];
/** RPMSIGTYPE_HEADERSIG (lib/rpmlead.c). */
const HEADER_SIGNATURE_TYPE = 5;

const invalid = (reason: string): FormatError => new FormatError('FORMAT_INVALID', `paquet RPM : ${reason}`);

export async function readRpmLayout(source: ByteSource, options: ParseOptions): Promise<RpmLayout> {
  throwIfAborted(options.signal);
  if (source.size > options.limits.maxPackageBytes) {
    throw new FormatError('FORMAT_LIMIT_EXCEEDED', `paquet de plus de ${options.limits.maxPackageBytes} octets`);
  }
  checkLead(await readAt(source, 0, LEAD_BYTES, options));
  const signature = await readHeader(source, LEAD_BYTES, 'signature', options);
  const headerStart = LEAD_BYTES + signature.byteLength + ((8 - (signature.byteLength % 8)) % 8);
  const header = await readHeader(source, headerStart, 'main', options);
  const headerEnd = headerStart + header.byteLength;
  if (headerEnd >= source.size) throw new FormatError('FORMAT_TRUNCATED', 'paquet RPM sans payload');
  checkSignature(signature, header, source.size - headerStart);
  return { signature, header, headerStart, headerEnd };
}

function checkLead(lead: Uint8Array): void {
  if (!LEAD_MAGIC.every((byte, index) => lead[index] === byte)) throw invalid('magie du lead absente');
  const view = new DataView(lead.buffer, lead.byteOffset, lead.byteLength);
  if (lead[4] !== 3) throw invalid('version de format non prise en charge');
  if (view.getUint16(6) !== 0) throw invalid('paquet source');
  if (view.getUint16(78) !== HEADER_SIGNATURE_TYPE) throw invalid('type de signature non pris en charge');
}

async function readHeader(source: ByteSource, offset: number, kind: 'signature' | 'main', options: ParseOptions) {
  const length = headerLength(await readAt(source, offset, 16, options), kind, options.limits);
  return parseRpmHeader(await readAt(source, offset, length, options), kind, options.limits);
}

async function readAt(source: ByteSource, offset: number, length: number, options: ParseOptions): Promise<Uint8Array> {
  if (offset + length > source.size) throw new FormatError('FORMAT_TRUNCATED', 'paquet RPM tronqué');
  return source.read(offset, length, options.signal);
}

/**
 * Empreintes de la signature (rpmvs.c) : SHA256HEADER obligatoire (rpm >= 4.14 l'écrit toujours),
 * SHA1HEADER vérifié s'il est présent ; SIZE ou LONGSIZE = en-tête principal + payload.
 */
function checkSignature(signature: RpmHeader, header: RpmHeader, headerAndPayload: number): void {
  const sha256 = signature.string(SIG.SHA256);
  if (sha256 === undefined) throw invalid('SHA256HEADER absent');
  if (sha256 !== createHash('sha256').update(header.bytes).digest('hex')) throw invalid('SHA256HEADER faux');
  const sha1 = signature.string(SIG.SHA1);
  if (sha1 !== undefined && sha1 !== createHash('sha1').update(header.bytes).digest('hex')) {
    throw invalid('SHA1HEADER faux');
  }
  for (const size of [...signature.uint32(SIG.SIZE), ...signature.uint64(SIG.LONGSIZE)]) {
    if (size !== headerAndPayload) throw invalid('taille déclarée différente du fichier');
  }
}
