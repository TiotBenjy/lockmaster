import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { LockmasterError } from '../domain/errors.js';

// Lecture des fichiers secrets (*_file, clé maîtresse) : docs/02 §3.3, deploy/lockmaster.example.toml.
// Refus si le fichier est accessible à « others » ou n'appartient ni à root ni au compte courant.
// Les contrôles portent sur le descripteur ouvert (fstat), donc sur la cible d'un éventuel lien.

export interface SecretFileOptions {
  maxBytes?: number;
  allowedUids?: readonly number[];
}

const DEFAULT_MAX_BYTES = 64 * 1024;

function defaultUids(): number[] {
  const uid = process.getuid?.();
  return uid === undefined ? [0] : [0, uid];
}

function fail(code: string, path: string, reason: string): LockmasterError {
  return new LockmasterError(code, `fichier secret ${path} : ${reason}`);
}

/** Lit un fichier secret après contrôle de son type, de son propriétaire, de ses droits et de sa taille. */
export function readSecretFile(path: string, options: SecretFileOptions = {}): Buffer {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const allowedUids = options.allowedUids ?? defaultUids();
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'inconnue';
    throw fail('SECRET_FILE_UNREADABLE', path, `illisible (${code})`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw fail('SECRET_FILE_NOT_REGULAR', path, "ce n'est pas un fichier ordinaire");
    if ((stat.mode & 0o007) !== 0) {
      throw fail('SECRET_FILE_PERMISSIONS', path, `accessible à « others » (mode ${(stat.mode & 0o777).toString(8)})`);
    }
    if (!allowedUids.includes(stat.uid)) {
      throw fail('SECRET_FILE_OWNER', path, `propriétaire ${stat.uid} non autorisé (root ou le compte du service)`);
    }
    if (stat.size > maxBytes) throw fail('SECRET_FILE_TOO_LARGE', path, `plus de ${maxBytes} octets`);
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

/** Vrai si `child` désigne `parent` ou un chemin situé dessous (après normalisation). */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}
