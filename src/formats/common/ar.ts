// Lecture de l'index d'une archive `ar` (enveloppe des .deb, deb(5)) : magie `!<arch>\n`, puis par
// membre un en-tête de 60 octets (nom 16, mtime 12, uid 6, gid 6, mode 8, taille 10, fin "`\n"),
// les données, et un `\n` d'alignement si la taille est impaire. Les noms longs GNU (`/n`) et les
// tables de symboles (`/`, `//`) n'existent pas dans un .deb : refusés.

import { FormatError, throwIfAborted } from './errors.js';
import type { ByteSource } from './source.js';

export interface ArMember {
  readonly name: string;
  /** Position des données du membre dans la source. */
  readonly offset: number;
  readonly size: number;
}

export interface ReadArOptions {
  readonly maxMembers: number;
  readonly signal?: AbortSignal;
}

const MAGIC = '!<arch>\n';
const HEADER_BYTES = 60;
const NAME_PATTERN = /^[A-Za-z0-9_.+-]{1,16}$/;
const SIZE_PATTERN = /^\d{1,10} *$/;

export async function readArMembers(source: ByteSource, options: ReadArOptions): Promise<ArMember[]> {
  throwIfAborted(options.signal);
  if (source.size < MAGIC.length || latin1(await source.read(0, MAGIC.length, options.signal)) !== MAGIC) {
    throw new FormatError('FORMAT_INVALID', 'archive ar : magie « !<arch> » absente');
  }
  const members: ArMember[] = [];
  let offset = MAGIC.length;
  while (offset < source.size) {
    if (members.length >= options.maxMembers) {
      throw new FormatError('FORMAT_LIMIT_EXCEEDED', `archive ar : plus de ${options.maxMembers} membres`);
    }
    const member = parseHeader(await source.read(offset, Math.min(HEADER_BYTES, source.size - offset)), offset);
    if (member.offset + member.size > source.size) {
      throw new FormatError('FORMAT_TRUNCATED', `archive ar : membre à ${offset} plus long que l'archive`);
    }
    members.push(member);
    offset = await skipPadding(source, member.offset + member.size, member.size, options.signal);
  }
  return members;
}

function parseHeader(header: Uint8Array, offset: number): ArMember {
  if (header.length < HEADER_BYTES) {
    throw new FormatError('FORMAT_TRUNCATED', `archive ar : en-tête tronqué à ${offset}`);
  }
  if (header.some((byte) => byte > 0x7e)) {
    throw new FormatError('FORMAT_INVALID', `archive ar : en-tête non ASCII à ${offset}`);
  }
  const text = latin1(header);
  const rawName = text.slice(0, 16).trimEnd();
  const name = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName;
  const size = text.slice(48, 58);
  if (text.slice(58, 60) !== '`\n' || !NAME_PATTERN.test(name) || name.includes('..') || !SIZE_PATTERN.test(size)) {
    throw new FormatError('FORMAT_INVALID', `archive ar : en-tête invalide à ${offset}`);
  }
  return { name, offset: offset + HEADER_BYTES, size: Number.parseInt(size, 10) };
}

/** Saute l'octet d'alignement d'un membre de taille impaire (toléré absent en fin d'archive). */
async function skipPadding(source: ByteSource, end: number, size: number, signal?: AbortSignal): Promise<number> {
  if (size % 2 === 0 || end === source.size) return end;
  const [pad] = await source.read(end, 1, signal);
  if (pad !== 0x0a) throw new FormatError('FORMAT_INVALID', `archive ar : octet d'alignement invalide à ${end}`);
  return end + 1;
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
}
