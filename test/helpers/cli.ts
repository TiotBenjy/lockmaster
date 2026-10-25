import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CliRuntime, runCli } from '../../src/cli/index.js';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Lance la CLI dans le processus de test, avec des sorties capturées. */
export async function cli(args: string[], overrides: Partial<CliRuntime> = {}): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const runtime: CliRuntime = {
    env: {},
    uid: process.getuid?.() ?? 1000,
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    ...overrides,
  };
  const code = await runCli(args, runtime);
  return { code, stdout, stderr };
}

/** Port TCP libre sur 127.0.0.1. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Installation de test : dossier temporaire avec config/, data/ et un lockmaster.toml. */
export function installation(port: number, extra = '') {
  const root = mkdtempSync(join(tmpdir(), 'lockmaster-cli-'));
  mkdirSync(join(root, 'etc'), { mode: 0o750 });
  const config = join(root, 'etc', 'lockmaster.toml');
  writeFileSync(
    config,
    `[server]
public_url = "http://127.0.0.1:${port}"
data_dir = "${root}/data"

[http]
listen = "127.0.0.1:${port}"

[security]
master_key_file = "${root}/etc/master.key"

[[publish.targets]]
name = "local"
kind = "local"
path = "${root}/repo"
public_url = "http://127.0.0.1:1"

[log]
level = "warn"
${extra}`,
  );
  return {
    root,
    config,
    keyFile: join(root, 'etc', 'master.key'),
    dataDir: join(root, 'data'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
