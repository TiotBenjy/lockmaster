import { closeSync, constants, fchmodSync, fchownSync, fsyncSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { LockmasterError } from '../domain/errors.js';

// Création de fichiers sensibles (clés) : jamais de remplacement d'un fichier existant, jamais de
// lien suivi (O_CREAT | O_EXCL | O_NOFOLLOW). Droits et propriétaire posés sur le descripteur ouvert,
// donc sur le fichier créé et sur lui seul. Écriture complète et durable (fsync du fichier et du
// dossier) ; en cas d'échec, le fichier partiel est supprimé.

export interface FileOwner {
  uid: number;
  gid: number;
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
}

function fsyncDirectory(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Crée `path` avec `content` ; échoue si le chemin existe déjà, même sous forme de lien. */
export function writeNewFile(path: string, content: string, mode: number, owner?: FileOwner): void {
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'inconnue';
    throw new LockmasterError('FILE_CREATE_REFUSED', `${path} : création refusée (${code}) ; aucun fichier remplacé`);
  }
  try {
    writeAll(fd, Buffer.from(content, 'utf8'));
    if (owner) fchownSync(fd, owner.uid, owner.gid);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(path);
    throw error;
  }
  closeSync(fd);
  fsyncDirectory(dirname(path));
}
