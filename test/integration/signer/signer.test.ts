import { chmodSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeFrame } from '../../../src/domain/signer-protocol.js';
import { loadSignerConfig } from '../../../src/signer/config.js';
import { startSigner } from '../../../src/signer/server.js';
import { createSignerClient } from '../../../src/signer-client/client.js';
import { LogCapture } from '../../helpers/deps.js';
import { decodeResponse, orphanSocket, rawExchange, signerCli, signerInstallation } from '../../helpers/signer.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function initialized(socketTimeout = '30s') {
  const install = signerInstallation('', socketTimeout);
  cleanups.push(install.cleanup);
  const result = await signerCli(['init', '--config', install.config]);
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  return install;
}

async function running(socketTimeout = '30s') {
  const install = await initialized(socketTimeout);
  const logs = new LogCapture();
  const signer = await startSigner(loadSignerConfig({ path: install.config, env: {} }), { logDestination: logs });
  cleanups.push(() => signer.stop());
  return { ...install, logs };
}

describe('lockmaster signer init / serve', () => {
  it('serve sans init : code 78 et « exécuter lockmaster signer init »', async () => {
    const install = signerInstallation();
    cleanups.push(install.cleanup);
    const result = await signerCli(['serve', '--config', install.config]);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('exécuter lockmaster signer init');
  });

  it('init crée la clé maîtresse du signataire (0400) et sa base (dossier 0700), et est idempotent', async () => {
    const install = await initialized();
    expect(statSync(install.keyFile).mode & 0o777).toBe(0o400);
    expect(statSync(install.dataDir).mode & 0o777).toBe(0o700);
    expect(existsSync(join(install.dataDir, 'signer.db'))).toBe(true);
    expect((await signerCli(['init', '--config', install.config])).code).toBe(0);
  });

  it("refuse une clé de la configuration de l'application (clé inconnue)", async () => {
    const install = signerInstallation('\n[http]\nlisten = ":8080"\n');
    cleanups.push(install.cleanup);
    expect((await signerCli(['init', '--config', install.config])).code).toBe(78);
  });

  it("refuse root (77) et les combinaisons d'options incohérentes (64)", async () => {
    const install = signerInstallation();
    cleanups.push(install.cleanup);
    expect((await signerCli(['init', '--config', install.config], { uid: 0 })).code).toBe(77);
    expect((await signerCli(['serve', '--config', install.config], { uid: 0 })).code).toBe(77);
    expect((await signerCli(['init', '--socket', '/run/x.sock', '--config', install.config])).code).toBe(64);
    expect((await signerCli(['serve', '--socket', '/run/x.sock', '--socket-activation'])).code).toBe(64);
  });

  it.each([
    ['8080', 'nombre interprété comme un port TCP'],
    ['relatif.sock', 'chemin relatif'],
    ['/run/../tmp/x.sock', 'segment ..'],
  ])('refuse --socket %s (%s)', async (socket) => {
    const install = await initialized();
    expect((await signerCli(['serve', '--socket', socket, '--config', install.config])).code).toBe(78);
  });

  it("refuse un data_dir existant accessible à d'autres comptes, ou qui est un lien", async () => {
    const install = signerInstallation();
    cleanups.push(install.cleanup);
    mkdirSync(install.dataDir, { mode: 0o750 });
    chmodSync(install.dataDir, 0o750);
    expect((await signerCli(['init', '--config', install.config])).code).toBe(1);
    rmSync(install.dataDir, { recursive: true });
    mkdirSync(join(install.root, 'ailleurs'), { mode: 0o700 });
    symlinkSync(join(install.root, 'ailleurs'), install.dataDir);
    expect((await signerCli(['init', '--config', install.config])).code).toBe(1);
  });

  it("refuse une base existante qui n'est pas celle du signataire", async () => {
    const install = signerInstallation();
    cleanups.push(install.cleanup);
    mkdirSync(install.dataDir, { mode: 0o700 });
    const foreign = new Database(join(install.dataDir, 'signer.db'));
    foreign.exec('CREATE TABLE autre (x)');
    foreign.close();
    const result = await signerCli(['init', '--config', install.config]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('signataire');
  });

  it('un fichier de configuration désigné mais illisible est une erreur, jamais ignoré', async () => {
    const install = signerInstallation();
    cleanups.push(install.cleanup);
    chmodSync(install.config, 0o000);
    expect((await signerCli(['init', '--config', install.config])).code).toBe(78);
  });
});

describe('socket du signataire', () => {
  it("répond à ping par le client de l'application", async () => {
    const { socket } = await running();
    expect(await createSignerClient({ socketPath: socket, timeoutMs: 2000 }).ping()).toBe(true);
  });

  it('crée le socket en 0660, avec le groupe du dossier setgid', async () => {
    const { socket } = await running();
    const stat = statSync(socket);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o660);
    expect(stat.gid).toBe(statSync(join(socket, '..')).gid);
  });

  it.each([
    ['opération inconnue', encodeFrame({ op: 'sign', key: 'x' }), 'SIGNER_UNKNOWN_OPERATION'],
    ['requête mal formée', encodeFrame({ op: 'ping', extra: true }), 'SIGNER_REQUEST_INVALID'],
    ['JSON invalide', Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from('{x}')]), 'SIGNER_FRAME_INVALID'],
    ['trame de plus de 16 Mio', Buffer.from([0xff, 0xff, 0xff, 0xff]), 'SIGNER_FRAME_TOO_LARGE'],
    [
      'deux requêtes',
      Buffer.concat([encodeFrame({ op: 'ping' }), encodeFrame({ op: 'ping' })]),
      'SIGNER_FRAME_INVALID',
    ],
  ])('refuse et journalise : %s', async (_label, payload, code) => {
    const { socket, logs } = await running();
    const response = decodeResponse(await rawExchange(socket, payload));
    expect(response).toMatchObject({ ok: false, error: { code } });
    expect(logs.lines.some((line) => line['event'] === 'signer.request_refused' && line['code'] === code)).toBe(true);
  });

  it('ferme une connexion inactive au-delà du délai', async () => {
    const { socket } = await running('200ms');
    const started = Date.now();
    const data = await rawExchange(socket, Buffer.alloc(0));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(decodeResponse(data)).toMatchObject({ ok: false, error: { code: 'SIGNER_TIMEOUT' } });
  });

  it("remplace un socket orphelin, mais refuse un fichier ordinaire à l'emplacement du socket", async () => {
    const install = await initialized();
    await orphanSocket(install.socket);
    expect(statSync(install.socket).isSocket()).toBe(true);
    const config = loadSignerConfig({ path: install.config, env: {} });
    const signer = await startSigner(config, { logDestination: new LogCapture() });
    expect(await createSignerClient({ socketPath: install.socket, timeoutMs: 2000 }).ping()).toBe(true);
    await signer.stop();

    writeFileSync(install.socket, 'pas un socket');
    await expect(startSigner(config, { logDestination: new LogCapture() })).rejects.toMatchObject({
      code: 'SIGNER_SOCKET_UNSAFE',
    });
  });

  it.each([
    ['groupe inconnu', 'groupe-inexistant-lockmaster'],
    ['autre groupe que celui du socket', String((process.getgid?.() ?? 0) + 1)],
  ])('refuse de démarrer si socket_group ne correspond pas au socket : %s', async (_label, group) => {
    const install = signerInstallation('', '30s', group);
    cleanups.push(install.cleanup);
    expect((await signerCli(['init', '--config', install.config])).code).toBe(0);
    await expect(
      startSigner(loadSignerConfig({ path: install.config, env: {} }), { logDestination: new LogCapture() }),
    ).rejects.toMatchObject({ code: 'SIGNER_SOCKET_UNSAFE' });
  });

  it('socket_group vide : accepte le groupe du dossier setgid (quadlets, groupe hôte sans nom)', async () => {
    const install = signerInstallation('', '30s', '');
    cleanups.push(install.cleanup);
    expect((await signerCli(['init', '--config', install.config])).code).toBe(0);
    const signer = await startSigner(loadSignerConfig({ path: install.config, env: {} }), {
      logDestination: new LogCapture(),
    });
    cleanups.push(() => signer.stop());
    expect(await createSignerClient({ socketPath: install.socket, timeoutMs: 2000 }).ping()).toBe(true);
  });

  it("refuse un dossier de socket modifiable par le groupe (l'application pourrait remplacer le socket)", async () => {
    const install = await initialized();
    chmodSync(join(install.socket, '..'), 0o2770);
    await expect(
      startSigner(loadSignerConfig({ path: install.config, env: {} }), { logDestination: new LogCapture() }),
    ).rejects.toMatchObject({ code: 'SIGNER_SOCKET_UNSAFE' });
  });

  it('libère les emplacements des clients qui gardent leur connexion ouverte après la réponse', async () => {
    const { socket } = await running();
    // 8 clients (la limite) reçoivent leur réponse mais ne ferment jamais leur côté.
    const halfOpen = await Promise.all(
      Array.from(
        { length: 8 },
        () =>
          new Promise<ReturnType<typeof createConnection>>((resolve) => {
            const connection = createConnection({ path: socket, allowHalfOpen: true });
            connection.on('connect', () => connection.write(encodeFrame({ op: 'ping' })));
            connection.on('data', () => resolve(connection));
          }),
      ),
    );
    cleanups.push(() => {
      for (const connection of halfOpen) connection.destroy();
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await createSignerClient({ socketPath: socket, timeoutMs: 2000 }).ping()).toBe(true);
  });
});
