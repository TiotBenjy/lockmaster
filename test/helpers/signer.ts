import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSignerCli } from '../../src/signer/cli.js';

/** Installation de test du signataire : dossier du socket (2750), données, clé, signer.toml. */
export function signerInstallation(extra = '', socketTimeout = '30s') {
  const root = mkdtempSync(join(tmpdir(), 'lockmaster-signer-'));
  const socketDir = join(root, 'run');
  mkdirSync(socketDir);
  chmodSync(socketDir, 0o2750);
  mkdirSync(join(root, 'etc'), { mode: 0o750 });
  const config = join(root, 'etc', 'signer.toml');
  writeFileSync(
    config,
    `[server]
data_dir = "${root}/data"

[security]
master_key_file = "${root}/etc/master.key"

[socket]
path = "${socketDir}/sign.sock"
timeout = "${socketTimeout}"

[log]
level = "info"
${extra}`,
  );
  return {
    root,
    config,
    socket: join(socketDir, 'sign.sock'),
    dataDir: join(root, 'data'),
    keyFile: join(root, 'etc', 'master.key'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Lance la CLI du signataire dans le processus de test, sorties capturées. */
export async function signerCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runSignerCli(args, {
    env: {},
    uid: process.getuid?.() ?? 1000,
    pid: process.pid,
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
  });
  return { code, stdout, stderr };
}

/** Laisse un socket orphelin à `path` : un processus l'écoute puis est tué sans pouvoir le supprimer. */
export async function orphanSocket(path: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ['-e', "require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('prêt'))", path],
    { shell: false, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
}

/** Envoie des octets bruts au socket et rend tout ce qui revient jusqu'à la fermeture. */
export function rawExchange(socket: string, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const connection = createConnection(socket);
    connection.on('connect', () => connection.write(payload));
    connection.on('data', (chunk: Buffer) => chunks.push(chunk));
    connection.on('close', () => resolve(Buffer.concat(chunks)));
    connection.on('error', reject);
  });
}

/** Décode la réponse (une trame) renvoyée par le signataire. */
export function decodeResponse(data: Buffer): { ok: boolean; error?: { code: string } } {
  return JSON.parse(data.subarray(4, 4 + data.readUInt32BE(0)).toString('utf8'));
}
