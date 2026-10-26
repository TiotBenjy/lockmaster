// Structure d'un .deb (deb(5)) : `debian-binary` en tête (format 2.x, une ligne puis d'éventuelles
// lignes ignorées), puis `control.tar[.gz|.xz|.zst]`, puis `data.tar[.gz|.xz|.zst|.bz2|.lzma]`, dans
// cet ordre. dpkg ignore les membres commençant par `_` et ceux qui suivent data.tar ; ici seules les
// signatures debsig (`_gpg*`) sont admises, n'importe où après debian-binary (docs/03 §2.1).

import { type ArMember, readArMembers } from '../common/ar.js';
import { asCompression, type Compression } from '../common/decompress.js';
import { FormatError } from '../common/errors.js';
import type { ByteSource } from '../common/source.js';
import type { ParseOptions } from '../package-format.js';

export interface DebMember {
  readonly member: ArMember;
  readonly compression: Compression;
}

export interface DebLayout {
  readonly control: DebMember;
  readonly data: DebMember;
}

/** Les membres utiles plus quelques signatures ; au-delà, l'archive n'est pas un .deb raisonnable. */
const MAX_MEMBERS = 16;
const DEBIAN_BINARY_MAX_BYTES = 256;
const CONTROL_MEMBER = /^control\.tar(\.gz|\.xz|\.zst|\.bz2|\.lzma)?$/;
const DATA_MEMBER = /^data\.tar(\.gz|\.xz|\.zst|\.bz2|\.lzma)?$/;
const CONTROL_EXTENSIONS: Readonly<Record<string, string>> = { '': 'none', '.gz': 'gzip', '.xz': 'xz', '.zst': 'zstd' };
const DATA_EXTENSIONS: Readonly<Record<string, string>> = { ...CONTROL_EXTENSIONS, '.bz2': 'bzip2', '.lzma': 'lzma' };

const invalid = (reason: string): FormatError => new FormatError('FORMAT_INVALID', `paquet deb : ${reason}`);

export async function readDebLayout(source: ByteSource, options: ParseOptions): Promise<DebLayout> {
  if (source.size > options.limits.maxPackageBytes) {
    throw new FormatError('FORMAT_LIMIT_EXCEEDED', `paquet de plus de ${options.limits.maxPackageBytes} octets`);
  }
  const members = await readArMembers(source, {
    maxMembers: MAX_MEMBERS,
    signal: options.signal,
  });
  const [first, ...rest] = members;
  if (first?.name !== 'debian-binary') throw invalid('debian-binary absent en tête');
  await checkFormatVersion(source, first, options.signal);
  let control: DebMember | undefined;
  let data: DebMember | undefined;
  for (const member of rest) {
    if (member.name.startsWith('_gpg')) continue;
    const controlMatch = CONTROL_MEMBER.exec(member.name);
    const dataMatch = DATA_MEMBER.exec(member.name);
    if (controlMatch !== null && control === undefined && data === undefined) {
      control = { member, compression: compressionOf(controlMatch[1], CONTROL_EXTENSIONS) };
    } else if (dataMatch !== null && control !== undefined && data === undefined) {
      data = { member, compression: compressionOf(dataMatch[1], DATA_EXTENSIONS) };
    } else {
      throw invalid('membre inattendu, en double ou hors de son ordre');
    }
  }
  if (control === undefined || data === undefined) throw invalid('control.tar ou data.tar absent');
  return { control, data };
}

async function checkFormatVersion(source: ByteSource, member: ArMember, signal?: AbortSignal): Promise<void> {
  if (member.size > DEBIAN_BINARY_MAX_BYTES) throw invalid('debian-binary trop long');
  const text = Buffer.from(await source.read(member.offset, member.size, signal)).toString('latin1');
  if (!/^2\.\d+\n/.test(text)) throw invalid('format autre que 2.x');
}

/** Extension -> algorithme ; une extension connue de dpkg mais non admise ici est refusée comme telle. */
function compressionOf(extension: string | undefined, allowed: Readonly<Record<string, string>>): Compression {
  const name = allowed[extension ?? ''];
  if (name === undefined) {
    throw new FormatError('FORMAT_UNSUPPORTED_COMPRESSION', 'paquet deb : compression non admise pour ce membre');
  }
  return asCompression(name);
}
