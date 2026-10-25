import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LockmasterError } from '../../../src/domain/errors.js';
import { MAX_FRAME_BYTES } from '../../../src/domain/signer-protocol.js';
import { createSignerClient, signerRequest } from '../../../src/signer-client/client.js';

// Le client ne doit jamais rester bloqué : signataire qui ferme sans répondre, qui répond goutte à
// goutte, ou message trop gros. Chaque cas se termine par un rejet typé, jamais par une exception
// non gérée qui arrêterait l'application.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fakeSigner(onConnection: (socket: Socket) => void): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'lockmaster-client-'));
  const path = join(dir, 'sign.sock');
  const server: Server = createServer(onConnection);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return path;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'aucune erreur';
  } catch (error) {
    return error instanceof LockmasterError ? error.code : String(error);
  }
}

describe('client du signataire', () => {
  it('signataire qui ferme sans répondre : SIGNER_UNAVAILABLE', async () => {
    const path = await fakeSigner((socket) => socket.on('data', () => socket.destroy()));
    expect(await codeOf(createSignerClient({ socketPath: path, timeoutMs: 5000 }).ping())).toBe('SIGNER_UNAVAILABLE');
  });

  it('réponse partielle puis fermeture : SIGNER_UNAVAILABLE', async () => {
    const path = await fakeSigner((socket) => socket.on('data', () => socket.end(Buffer.from([0, 0, 0, 50, 0x7b]))));
    expect(await codeOf(createSignerClient({ socketPath: path, timeoutMs: 5000 }).ping())).toBe('SIGNER_UNAVAILABLE');
  });

  it("réponse goutte à goutte au-delà de l'échéance totale : rejet", async () => {
    const path = await fakeSigner((socket) => {
      const header = Buffer.from([0, 0, 0, 100]);
      let sent = 0;
      const drip = setInterval(() => {
        if (socket.destroyed) return clearInterval(drip);
        socket.write(sent < 4 ? header.subarray(sent, sent + 1) : Buffer.from(' '));
        sent += 1;
      }, 50);
      socket.on('close', () => clearInterval(drip));
    });
    const started = Date.now();
    expect(await codeOf(createSignerClient({ socketPath: path, timeoutMs: 400 }).ping())).toBe('SIGNER_UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('message de plus de 16 Mio : rejet de la seule requête, sans exception non gérée', async () => {
    const path = await fakeSigner(() => {});
    const huge = { op: 'ping', padding: 'x'.repeat(MAX_FRAME_BYTES) };
    expect(await codeOf(signerRequest({ socketPath: path, timeoutMs: 2000 }, huge))).toBe('SIGNER_FRAME_TOO_LARGE');
  });
});
