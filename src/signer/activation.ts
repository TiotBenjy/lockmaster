import { LockmasterError } from '../domain/errors.js';

// Activation par socket systemd (lockmaster-signer.socket) : protocole sd_listen_fds. Le socket
// transmis est le descripteur 3 ; un seul est attendu, et seulement s'il est destiné à ce processus.

const SD_LISTEN_FDS_START = 3;

export function activationFd(env: Readonly<Record<string, string | undefined>>, pid: number): number {
  const listenPid = env['LISTEN_PID'];
  const count = env['LISTEN_FDS'];
  if (!listenPid || !/^[1-9]\d*$/.test(listenPid) || Number(listenPid) !== pid) {
    throw new LockmasterError('SIGNER_ACTIVATION_INVALID', 'aucun socket transmis par systemd à ce processus');
  }
  if (count !== '1') {
    throw new LockmasterError('SIGNER_ACTIVATION_INVALID', `un socket attendu, ${count ?? 'aucun'} transmis`);
  }
  return SD_LISTEN_FDS_START;
}

/**
 * Un socket transmis par systemd pourrait être TCP (surcharge de l'unité) et l'hériter contournerait
 * PrivateNetwork : seule une adresse de socket Unix (chemin) est acceptée.
 */
export function assertUnixListener(address: unknown): void {
  if (typeof address !== 'string' || address === '') {
    throw new LockmasterError('SIGNER_ACTIVATION_INVALID', "le socket transmis n'est pas un socket Unix");
  }
}
