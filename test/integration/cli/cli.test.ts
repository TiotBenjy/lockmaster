import { chmodSync, existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cli, freePort, installation } from '../../helpers/cli.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function setup(extra = '') {
  const install = installation(await freePort(), extra);
  cleanups.push(install.cleanup);
  return install;
}

describe('lockmaster : aide, usage, root', () => {
  it('--help liste les commandes ; --version affiche la version', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    for (const command of ['serve', 'init', 'config check', 'healthcheck', 'keys gen-master']) {
      expect(help.stdout).toContain(command);
    }
    const version = await cli(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each([[['inconnue']], [['serve', '--option-inconnue']], [[]], [['config']]])(
    'usage incorrect %j : code 64',
    async (args) => {
      const result = await cli(args);
      expect(result.code).toBe(64);
      expect(result.stderr).not.toBe('');
    },
  );

  it('refuse de tourner en root, sauf init', async () => {
    const { config } = await setup();
    const asRoot = await cli(['config', 'check', '--config', config], { uid: 0 });
    expect(asRoot.code).toBe(77);
    expect(asRoot.stderr).toContain('root');
  });
});

describe('lockmaster keys gen-master', () => {
  it('écrit 32 octets aléatoires en base64 sur la sortie standard', async () => {
    const a = await cli(['keys', 'gen-master']);
    const b = await cli(['keys', 'gen-master']);
    expect(a.code).toBe(0);
    expect(Buffer.from(a.stdout.trim(), 'base64')).toHaveLength(32);
    expect(a.stdout).not.toBe(b.stdout);
  });

  it('--out crée un fichier 0400 et ne remplace jamais un fichier ni ne suit un lien', async () => {
    const { root } = await setup();
    const out = join(root, 'new.key');
    expect((await cli(['keys', 'gen-master', '--out', out])).code).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o400);
    const before = readFileSync(out, 'utf8');
    const again = await cli(['keys', 'gen-master', '--out', out]);
    expect(again.code).toBe(1);
    expect(readFileSync(out, 'utf8')).toBe(before);

    symlinkSync(join(root, 'cible.key'), join(root, 'lien.key'));
    expect((await cli(['keys', 'gen-master', '--out', join(root, 'lien.key')])).code).toBe(1);
    expect(existsSync(join(root, 'cible.key'))).toBe(false);
  });
});

describe('lockmaster config check|show', () => {
  it('valide la configuration et affiche la configuration effective', async () => {
    const { config } = await setup();
    const check = await cli(['config', 'check', '--config', config]);
    expect(check.code).toBe(0);
    expect(check.stdout).toContain('valide');
    const show = await cli(['config', 'show', '--config', config]);
    expect(JSON.parse(show.stdout).http.listen.host).toBe('127.0.0.1');
  });

  it('configuration invalide : code 78 et clé fautive nommée', async () => {
    const { config } = await setup('\n[metrics]\nlisten_metrics = "nope"\n');
    const result = await cli(['config', 'check', '--config', config]);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('metrics.listen_metrics');
  });

  it('LOCKMASTER_CONFIG est lu quand --config est absent', async () => {
    const { config } = await setup();
    expect((await cli(['config', 'check'], { env: { LOCKMASTER_CONFIG: config } })).code).toBe(0);
  });
});

describe('lockmaster serve sans init (code 78)', () => {
  it('clé maîtresse absente', async () => {
    const { config } = await setup();
    const result = await cli(['serve', '--config', config]);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('exécuter lockmaster init');
  });

  it('clé présente mais base absente', async () => {
    const { config, keyFile } = await setup();
    await cli(['keys', 'gen-master', '--out', keyFile]);
    const result = await cli(['serve', '--config', config]);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('exécuter lockmaster init');
  });

  it('clé maîtresse invalide ou lisible par « others »', async () => {
    const { config, keyFile } = await setup();
    await cli(['init', '--non-interactive', '--config', config]);
    chmodSync(keyFile, 0o644);
    expect((await cli(['serve', '--config', config])).code).toBe(78);
    chmodSync(keyFile, 0o600);
    writeFileSync(keyFile, 'trop-courte\n');
    const result = await cli(['serve', '--config', config]);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('32 octets');
  });
});

describe('lockmaster init', () => {
  it('crée la clé maîtresse (0400), le dossier de données (0750) et la base ; idempotent', async () => {
    const { config, keyFile, dataDir } = await setup();
    const first = await cli(['init', '--non-interactive', '--config', config]);
    expect(first.stderr).toBe('');
    expect(first.code).toBe(0);
    expect(statSync(keyFile).mode & 0o777).toBe(0o400);
    expect(statSync(dataDir).mode & 0o777).toBe(0o750);
    expect(existsSync(join(dataDir, 'lockmaster.db'))).toBe(true);

    const key = readFileSync(keyFile, 'utf8');
    const second = await cli(['init', '--non-interactive', '--config', config]);
    expect(second.code).toBe(0);
    expect(readFileSync(keyFile, 'utf8')).toBe(key);
  });

  it('vérifie le fichier de mot de passe administrateur (droits, longueur)', async () => {
    const { config, root } = await setup();
    const password = join(root, 'admin_password');
    writeFileSync(password, 'correct horse battery staple\n', { mode: 0o600 });
    expect((await cli(['init', '--non-interactive', '--admin-password-file', password, '--config', config])).code).toBe(
      0,
    );

    writeFileSync(password, 'court\n');
    expect((await cli(['init', '--non-interactive', '--admin-password-file', password, '--config', config])).code).toBe(
      1,
    );
    // Fichier secret lisible par « others » : erreur d'installation (78), comme pour la clé maîtresse.
    writeFileSync(password, 'correct horse battery staple\n');
    chmodSync(password, 0o644);
    const insecure = await cli(['init', '--non-interactive', '--admin-password-file', password, '--config', config]);
    expect(insecure.code).toBe(78);
    expect(insecure.stderr).toContain('others');
  });

  it("refuse une base existante qui n'est pas une base lockmaster", async () => {
    const { config, dataDir } = await setup();
    await cli(['init', '--non-interactive', '--config', config]);
    writeFileSync(join(dataDir, 'lockmaster.db'), 'pas une base sqlite');
    expect((await cli(['init', '--non-interactive', '--config', config])).code).not.toBe(0);
  });
});
