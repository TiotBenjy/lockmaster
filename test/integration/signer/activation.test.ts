import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSignerClient } from '../../../src/signer-client/client.js';
import { REPO_ROOT } from '../../helpers/run-script.js';
import { signerCli, signerInstallation } from '../../helpers/signer.js';

// Activation par socket (lockmaster-signer.socket) : le signataire reçoit un socket Unix déjà à
// l'écoute en descripteur 3. Il doit le servir ; un descripteur TCP doit être refusé.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Descripteur du serveur à l'écoute (interne à Node, utilisé seulement pour imiter systemd). */
function fdOf(server: Server): number {
  return (server as unknown as { _handle: { fd: number } })._handle.fd;
}

function listening(server: Server, target: string | { port: number; host: string }): Promise<void> {
  return new Promise((resolve) => {
    if (typeof target === 'string') server.listen(target, resolve);
    else server.listen(target.port, target.host, resolve);
  });
}

function activatedSigner(config: string, fd: number) {
  let output = '';
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      join(REPO_ROOT, 'test/fixtures/signer-activated.ts'),
      'serve',
      '--socket-activation',
      '--config',
      config,
    ],
    {
      cwd: REPO_ROOT,
      env: { PATH: process.env['PATH'] ?? '/usr/bin', TMPDIR: tmpdir() },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe', fd],
    },
  );
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  cleanups.push(() => {
    child.kill('SIGKILL');
  });
  return { child, output: () => output };
}

async function initializedInstall() {
  const install = signerInstallation();
  cleanups.push(install.cleanup);
  expect((await signerCli(['init', '--config', install.config])).code).toBe(0);
  return install;
}

describe('activation par socket systemd', () => {
  it('sert un socket Unix hérité en descripteur 3', async () => {
    const install = await initializedInstall();
    const inherited = createServer();
    await listening(inherited, install.socket);
    cleanups.push(() => new Promise<void>((resolve) => inherited.close(() => resolve())));
    activatedSigner(install.config, fdOf(inherited));
    // Le signataire et ce processus écoutent le même socket : on réessaie jusqu'à tomber sur lui.
    const client = createSignerClient({ socketPath: install.socket, timeoutMs: 1000 });
    inherited.on('connection', (socket) => socket.destroy());
    const deadline = Date.now() + 15_000;
    let answered = false;
    while (!answered && Date.now() < deadline) {
      answered = await client.ping().catch(() => false);
      if (!answered) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(answered).toBe(true);
  });

  it('refuse un descripteur TCP hérité (code 78)', async () => {
    const install = await initializedInstall();
    const tcp = createServer();
    await listening(tcp, { port: 0, host: '127.0.0.1' });
    cleanups.push(() => new Promise<void>((resolve) => tcp.close(() => resolve())));
    const signer = activatedSigner(install.config, fdOf(tcp));
    const code = await new Promise<number | null>((resolve) => signer.child.once('exit', resolve));
    expect(signer.output()).toContain('socket Unix');
    expect(code).toBe(78);
  });
});
