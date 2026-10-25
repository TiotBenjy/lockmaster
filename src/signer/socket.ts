import { lstatSync, type Stats, unlinkSync } from 'node:fs';
import type { Server } from 'node:net';
import { dirname } from 'node:path';
import { LockmasterError } from '../domain/errors.js';
import { resolveGroup } from '../system/groups.js';
import { assertUnixListener } from './activation.js';

// Écoute sur un chemin (--socket, conteneurs). Garanties (ADR-0009, docs/02 §3.7 bis) :
//  - le dossier du socket appartient à root ou au signataire et n'est modifiable ni par le groupe
//    ni par « others » : l'application (membre du groupe) ne peut ni supprimer ni remplacer le socket ;
//  - le socket naît en 0660 (masque), appartient au signataire, avec le groupe server.socket_group
//    (vide : celui du dossier setgid) ;
//  - un socket orphelin (arrêt brutal) est remplacé ; tout autre fichier à cet emplacement est refusé.

const SOCKET_MODE = 0o660;

function unsafe(path: string, reason: string): LockmasterError {
  return new LockmasterError('SIGNER_SOCKET_UNSAFE', `socket ${path} : ${reason}`);
}

function checkDirectory(path: string): Stats {
  const dir = lstatSync(dirname(path));
  if (!dir.isDirectory()) throw unsafe(path, "le dossier parent n'est pas un dossier");
  if (![0, process.geteuid?.()].includes(dir.uid)) {
    throw unsafe(path, `dossier parent appartenant à ${dir.uid}, ni root ni le signataire`);
  }
  if ((dir.mode & 0o022) !== 0) throw unsafe(path, 'dossier parent modifiable par le groupe ou « others »');
  return dir;
}

function removeOrphan(path: string): void {
  let existing: Stats;
  try {
    existing = lstatSync(path);
  } catch {
    return;
  }
  if (!existing.isSocket()) throw unsafe(path, "un fichier qui n'est pas un socket occupe cet emplacement");
  unlinkSync(path);
}

/**
 * Groupe que doit porter le socket : `server.socket_group` (nom ou numéro) ; s'il est vide, le
 * groupe du dossier quand il est setgid, sinon le groupe effectif du processus. Le dossier n'est
 * consulté (et lu s'il n'est pas fourni) que dans ce dernier cas.
 */
export function expectedSocketGroup(socketGroup: string, path: string, dir?: Stats): number {
  if (socketGroup !== '') {
    try {
      return resolveGroup(socketGroup);
    } catch {
      throw unsafe(path, `groupe « ${socketGroup} » introuvable`);
    }
  }
  const parent = dir ?? lstatSync(dirname(path));
  return (parent.mode & 0o2000) !== 0 ? parent.gid : (process.getegid?.() ?? -1);
}

function verify(path: string, expectedGid: number): void {
  const socket = lstatSync(path);
  if (!socket.isSocket()) throw unsafe(path, "ce n'est pas un socket");
  if (socket.uid !== process.geteuid?.()) throw unsafe(path, `propriétaire ${socket.uid}, pas le signataire`);
  const mode = socket.mode & 0o777;
  if (mode !== SOCKET_MODE) throw unsafe(path, `mode ${mode.toString(8)} au lieu de 660`);
  if (socket.gid !== expectedGid) throw unsafe(path, `groupe ${socket.gid} au lieu de ${expectedGid}`);
}

function listen(server: Server, options: { path: string } | { fd: number }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function closeAndThrow(server: Server, error: unknown): Promise<never> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  throw error;
}

export async function listenOnPath(server: Server, path: string, socketGroup: string): Promise<void> {
  const dir = checkDirectory(path);
  const expectedGid = expectedSocketGroup(socketGroup, path, dir);
  removeOrphan(path);
  // Le masque fixe les droits à la création : aucune fenêtre où le socket serait plus ouvert.
  const previous = process.umask(0o117);
  try {
    await listen(server, { path });
  } finally {
    process.umask(previous);
  }
  try {
    verify(path, expectedGid);
  } catch (error) {
    await closeAndThrow(server, error);
  }
}

/** Activation systemd : le descripteur transmis doit être un socket Unix (jamais un port TCP). */
export async function listenOnFd(server: Server, fd: number): Promise<void> {
  await listen(server, { fd });
  try {
    assertUnixListener(server.address());
  } catch (error) {
    await closeAndThrow(server, error);
  }
}
