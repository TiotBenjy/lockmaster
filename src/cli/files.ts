import { closeSync, constants, fchmodSync, fchownSync, openSync, writeSync } from 'node:fs';
import { LockmasterError } from '../domain/errors.js';

// Création de fichiers sensibles (clés) : jamais de remplacement d'un fichier existant, jamais de
// lien suivi (O_CREAT | O_EXCL | O_NOFOLLOW). Droits et propriétaire posés sur le descripteur ouvert,
// donc sur le fichier créé et sur lui seul.

export interface FileOwner {
  uid: number;
  gid: number;
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
    writeSync(fd, content);
    if (owner) fchownSync(fd, owner.uid, owner.gid);
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}
