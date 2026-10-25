import { type ChildProcess, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cli, freePort, installation } from '../../helpers/cli.js';
import { REPO_ROOT } from '../../helpers/run-script.js';

// Le vrai processus `lockmaster` (src/main.ts chargé par tsx) : codes de sortie et signaux.

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function lockmaster(args: string[]): ChildProcess & { output: () => string } {
  const child = spawn(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'src/main.ts'), ...args], {
    cwd: REPO_ROOT,
    // Environnement minimal ; tsx a besoin d'un dossier temporaire pour son cache.
    env: { PATH: process.env['PATH'] ?? '/usr/bin', TMPDIR: tmpdir() },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  cleanups.push(() => child.kill('SIGKILL'));
  return Object.assign(child, { output: () => output });
}

const exitOf = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // pas encore à l'écoute
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe('processus lockmaster', () => {
  it('serve sans init sort avec le code 78 et le message « exécuter lockmaster init »', async () => {
    const install = installation(await freePort());
    cleanups.push(install.cleanup);
    const child = lockmaster(['serve', '--config', install.config]);
    const code = await exitOf(child);
    expect(child.output()).toContain('exécuter lockmaster init');
    expect(code).toBe(78);
  });

  it("serve après init répond, puis s'arrête proprement (code 0) sur SIGTERM", async () => {
    const port = await freePort();
    const install = installation(port);
    cleanups.push(install.cleanup);
    expect((await cli(['init', '--non-interactive', '--config', install.config])).code).toBe(0);

    const child = lockmaster(['serve', '--config', install.config]);
    const exited = exitOf(child);
    expect(await waitForHealth(`http://127.0.0.1:${port}/healthz`, 15_000)).toBe(true);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  });
});
