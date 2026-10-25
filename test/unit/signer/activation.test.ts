import { describe, expect, it } from 'vitest';
import { LockmasterError } from '../../../src/domain/errors.js';
import { activationFd, assertUnixListener } from '../../../src/signer/activation.js';

// Activation par socket systemd (sd_listen_fds) : le socket est le descripteur 3.

describe('activationFd', () => {
  it('rend le descripteur 3 quand systemd en a transmis un seul à ce processus', () => {
    expect(activationFd({ LISTEN_PID: '1234', LISTEN_FDS: '1' }, 1234)).toBe(3);
  });

  it.each([
    [{}, 'variables absentes'],
    [{ LISTEN_PID: '999', LISTEN_FDS: '1' }, 'destinées à un autre processus'],
    [{ LISTEN_PID: '1234', LISTEN_FDS: '2' }, 'plusieurs sockets'],
    [{ LISTEN_PID: '1234', LISTEN_FDS: '0' }, 'aucun socket'],
    [{ LISTEN_PID: '1234x', LISTEN_FDS: '1' }, 'PID mal formé'],
  ])('refuse %j (%s)', (env, _reason) => {
    expect(() => activationFd(env, 1234)).toThrow(LockmasterError);
  });
});

describe('assertUnixListener', () => {
  it('accepte un socket Unix : chemin, ou null pour un socket Unix hérité par descripteur', () => {
    expect(() => assertUnixListener('/run/lockmaster-sign/sign.sock')).not.toThrow();
    // Node renvoie null pour un socket Unix reçu par descripteur (pas de getsockname sur un Pipe).
    expect(() => assertUnixListener(null)).not.toThrow();
  });

  it.each([[{ address: '0.0.0.0', family: 'IPv4', port: 9000 }], [{ address: '::1', family: 'IPv6', port: 1 }]])(
    "refuse un descripteur transmis qui n'est pas un socket Unix : %j",
    (address) => {
      expect(() => assertUnixListener(address)).toThrow(LockmasterError);
    },
  );
});
