import { lstatSync, statSync, unlinkSync } from 'node:fs';
import type { Server } from 'node:net';
import { dirname } from 'node:path';
import { LockmasterError } from '../domain/errors.js';

// Écoute sur un chemin (--socket, conteneurs) : le socket doit naître en 0660, avec le groupe du
// dossier setgid (lockmaster-sign, ADR-0009), dans un dossier que personne d'autre ne peut modifier.
// Un socket orphelin (arrêt brutal) est remplacé ; tout autre fichier à cet emplacement est refusé.

const SOCKET_MODE = 0o660;

function unsafe(path: string, reason: string): LockmasterError {
  return new LockmasterError('SIGNER_SOCKET_UNSAFE', `socket ${path} : ${reason}`);
}

function prepare(path: string): void {
  const dir = lstatSync(dirname(path));
  if (!dir.isDirectory()) throw unsafe(path, "le dossier parent n'est pas un dossier");
  if ((dir.mode & 0o002) !== 0) throw unsafe(path, 'dossier parent modifiable par « others »');
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(path);
  } catch {
    return;
  }
  if (!existing.isSocket()) throw unsafe(path, "un fichier qui n'est pas un socket occupe cet emplacement");
  unlinkSync(path);
}

function verify(path: string): void {
  const socket = statSync(path);
  const dir = statSync(dirname(path));
  if ((socket.mode & 0o777) !== SOCKET_MODE)
    throw unsafe(path, `mode ${(socket.mode & 0o777).toString(8)} au lieu de 660`);
  const expectedGid = (dir.mode & 0o2000) !== 0 ? dir.gid : process.getegid?.();
  if (socket.gid !== expectedGid) throw unsafe(path, `groupe ${socket.gid} au lieu de ${String(expectedGid)}`);
}

export async function listenOnPath(server: Server, path: string): Promise<void> {
  prepare(path);
  // Le masque fixe les droits à la création : aucune fenêtre où le socket serait plus ouvert.
  const previous = process.umask(0o117);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } finally {
    process.umask(previous);
  }
  try {
    verify(path);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}

export async function listenOnFd(server: Server, fd: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ fd }, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
