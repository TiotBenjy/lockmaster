// Lecture d'un seul membre gzip (RFC 1952) à une position donnée, avec sa longueur compressée exacte :
// les .apk sont des membres gzip concaténés et apk-tools calcule ses empreintes (signature, `C:`) sur
// les octets compressés de chaque membre. Le flux deflate est décodé par `node:zlib` (inflateRawSync,
// `bytesWritten` = octets consommés) sur une fenêtre bornée, puis l'en-queue CRC32 et ISIZE est vérifiée.

import { crc32, inflateRawSync } from 'node:zlib';
import { at } from './bytes.js';
import { FormatError, throwIfAborted } from './errors.js';
import type { ByteSource } from './source.js';

export interface GzipMember {
  readonly offset: number;
  /** Octets du membre complet (en-tête, données deflate, CRC32 et ISIZE). */
  readonly length: number;
  readonly data: Uint8Array;
}

export interface GzipMemberOptions {
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal | undefined;
}

interface InflateInfo {
  readonly buffer: Buffer;
  /** Octets d'entrée consommés jusqu'à la fin du flux deflate. */
  readonly engine: { readonly bytesWritten: number };
}

const FHCRC = 0x02;
const FEXTRA = 0x04;
const FNAME = 0x08;
const FCOMMENT = 0x10;
const RESERVED = 0xe0;
const MAX_STRING_BYTES = 1024;

const corrupt = (reason: string): FormatError => new FormatError('FORMAT_CORRUPT_STREAM', `membre gzip : ${reason}`);
const invalid = (reason: string): FormatError => new FormatError('FORMAT_INVALID', `membre gzip : ${reason}`);

export async function readGzipMember(
  source: ByteSource,
  offset: number,
  options: GzipMemberOptions,
): Promise<GzipMember> {
  throwIfAborted(options.signal);
  if (offset >= source.size) throw new FormatError('FORMAT_TRUNCATED', 'membre gzip absent');
  // Une sortie de n octets tient en moins de n + n/1000 + 64 Kio de deflate (blocs stockés au pire).
  const window = await source.read(
    offset,
    Math.min(source.size - offset, options.maxOutputBytes + (options.maxOutputBytes >> 10) + 65_536),
    options.signal,
  );
  const headerLength = readHeader(window);
  let data: Buffer;
  let consumed: number;
  try {
    // Avec `info: true`, Node rend { buffer, engine } (documentation de zlib, « Convenience methods ») ;
    // ses types ne décrivent pas cette forme.
    const result = inflateRawSync(window.subarray(headerLength), {
      info: true,
      maxOutputLength: options.maxOutputBytes,
    }) as unknown as InflateInfo;
    data = result.buffer;
    consumed = result.engine.bytesWritten;
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new FormatError('FORMAT_LIMIT_EXCEEDED', `membre gzip de plus de ${options.maxOutputBytes} octets`);
    }
    throw corrupt('données deflate invalides');
  }
  const trailer = headerLength + consumed;
  if (trailer + 8 > window.length) throw corrupt('en-queue absente');
  const view = new DataView(window.buffer, window.byteOffset + trailer, 8);
  if (view.getUint32(0, true) !== crc32(data) || view.getUint32(4, true) !== data.length % 2 ** 32) {
    throw corrupt('CRC ou taille faux');
  }
  return { offset, length: trailer + 8, data };
}

/** En-tête de 10 octets puis champs facultatifs ; rend sa longueur. */
function readHeader(window: Uint8Array): number {
  if (window.length < 10) throw corrupt('en-tête tronqué');
  if (window[0] !== 0x1f || window[1] !== 0x8b) throw invalid('magie absente');
  if (window[2] !== 8) throw invalid('méthode autre que deflate');
  const flags = at(window, 3);
  if ((flags & RESERVED) !== 0) throw invalid('drapeaux réservés');
  let position = 10;
  if (flags & FEXTRA) {
    if (position + 2 > window.length) throw corrupt('en-tête tronqué');
    position += 2 + (at(window, position) | (at(window, position + 1) << 8));
  }
  if (flags & FNAME) position = afterString(window, position);
  if (flags & FCOMMENT) position = afterString(window, position);
  if (flags & FHCRC) {
    if (position + 2 > window.length) throw corrupt('en-tête tronqué');
    const stored = at(window, position) | (at(window, position + 1) << 8);
    if (stored !== (crc32(window.subarray(0, position)) & 0xffff)) throw invalid("CRC d'en-tête faux");
    position += 2;
  }
  if (position >= window.length) throw corrupt('en-tête tronqué');
  return position;
}

function afterString(window: Uint8Array, position: number): number {
  const end = window.subarray(position, position + MAX_STRING_BYTES).indexOf(0);
  if (end < 0) throw corrupt('champ de texte non terminé');
  return position + end + 1;
}
