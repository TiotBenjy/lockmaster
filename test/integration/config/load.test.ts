import { symlinkSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig, resolveConfigPath } from '../../../src/config/load.js';
import { LockmasterError } from '../../../src/domain/errors.js';
import { makeTree } from '../../helpers/run-script.js';

const MINIMAL_TOML = `
[server]
public_url = "https://lockmaster.example.com"
data_dir = "/var/lib/lockmaster"

[[publish.targets]]
name = "local"
kind = "local"
path = "/srv/lockmaster-repo"
public_url = "https://repo.example.com"
`;

function withFile(content: string) {
  const { root, cleanup } = makeTree({ 'etc/lockmaster.toml': content });
  return { file: `${root}/etc/lockmaster.toml`, root, cleanup };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof LockmasterError ? error.code : String(error);
  }
  return undefined;
}

describe('resolveConfigPath', () => {
  it('--config > LOCKMASTER_CONFIG > /etc/lockmaster/lockmaster.toml', () => {
    expect(resolveConfigPath('/a.toml', { LOCKMASTER_CONFIG: '/b.toml' })).toBe('/a.toml');
    expect(resolveConfigPath(undefined, { LOCKMASTER_CONFIG: '/b.toml' })).toBe('/b.toml');
    expect(resolveConfigPath(undefined, {})).toBe('/etc/lockmaster/lockmaster.toml');
    expect(resolveConfigPath(undefined, { LOCKMASTER_CONFIG: '' })).toBe('/etc/lockmaster/lockmaster.toml');
  });
});

describe('loadConfig', () => {
  it('charge un fichier minimal et complète par les valeurs par défaut', () => {
    const { file, cleanup } = withFile(MINIMAL_TOML);
    try {
      const config = loadConfig({ path: file, env: {} });
      expect(config.server.data_dir).toBe('/var/lib/lockmaster');
      expect(config.http.listen).toEqual({ host: '0.0.0.0', port: 8080 });
      expect(config.publish.targets[0]?.name).toBe('local');
    } finally {
      cleanup();
    }
  });

  it("applique les variables d'environnement après le fichier", () => {
    const { file, cleanup } = withFile(MINIMAL_TOML);
    try {
      const config = loadConfig({ path: file, env: { LOCKMASTER__HTTP__LISTEN: '127.0.0.1:9999' } });
      expect(config.http.listen).toEqual({ host: '127.0.0.1', port: 9999 });
    } finally {
      cleanup();
    }
  });

  it('résout les chemins relatifs par rapport au dossier du fichier de configuration', () => {
    const toml = MINIMAL_TOML.replace('data_dir = "/var/lib/lockmaster"', 'data_dir = "./.data"').replace(
      'path = "/srv/lockmaster-repo"',
      'path = "../repo"',
    );
    const { file, root, cleanup } = withFile(`${toml}\n[security]\nmaster_key_file = "keys/master.key"\n`);
    try {
      const config = loadConfig({ path: file, env: {} });
      expect(config.server.data_dir).toBe(`${root}/etc/.data`);
      expect(config.security.master_key_file).toBe(`${root}/etc/keys/master.key`);
      expect(config.publish.targets[0]).toMatchObject({ path: `${root}/repo` });
    } finally {
      cleanup();
    }
  });

  it.each([
    ['fichier absent', null, 'CONFIG_NOT_FOUND'],
    ['TOML invalide', '[server\n', 'CONFIG_INVALID'],
    ['clé inconnue', `${MINIMAL_TOML}\n[http]\nlistn = ":80"\n`, 'CONFIG_INVALID'],
    ['public_url manquant', MINIMAL_TOML.replace(/public_url = "https:\/\/lockmaster[^\n]*\n/, ''), 'CONFIG_INVALID'],
    [
      'clé maîtresse sous data_dir',
      `${MINIMAL_TOML}\n[security]\nmaster_key_file = "/var/lib/lockmaster/master.key"\n`,
      'CONFIG_INVALID',
    ],
  ])('refuse : %s', (_label, content, code) => {
    if (content === null) {
      expect(codeOf(() => loadConfig({ path: '/nonexistent/lockmaster.toml', env: {} }))).toBe(code);
      return;
    }
    const { file, cleanup } = withFile(content);
    try {
      expect(codeOf(() => loadConfig({ path: file, env: {} }))).toBe(code);
    } finally {
      cleanup();
    }
  });

  it('refuse une clé maîtresse située sous data_dir à travers un lien symbolique', () => {
    const { root, cleanup } = makeTree({ 'data/master.key': 'x', 'etc/keep': '' });
    try {
      symlinkSync(`${root}/data`, `${root}/datalink`);
      const toml = MINIMAL_TOML.replace('data_dir = "/var/lib/lockmaster"', `data_dir = "${root}/datalink"`);
      const file = `${root}/etc/lockmaster.toml`;
      writeFileSync(file, `${toml}\n[security]\nmaster_key_file = "${root}/data/master.key"\n`);
      expect(codeOf(() => loadConfig({ path: file, env: {} }))).toBe('CONFIG_INVALID');
      // Clé pas encore créée : c'est le dossier parent réel qui compte.
      writeFileSync(file, `${toml}\n[security]\nmaster_key_file = "${root}/data/sub/../absente.key"\n`);
      expect(codeOf(() => loadConfig({ path: file, env: {} }))).toBe('CONFIG_INVALID');
    } finally {
      cleanup();
    }
  });

  it('refuse une clé maîtresse désignée par un lien pendant qui pointe sous data_dir', () => {
    const { root, cleanup } = makeTree({ 'data/keep': '', 'etc/keep': '' });
    try {
      // Fichier lien pendant, puis dossier lien pendant : la clé serait créée dans data_dir.
      symlinkSync(`${root}/data/master.key`, `${root}/etc/master.key`);
      symlinkSync('../data/sub', `${root}/etc/kdir`);
      const file = `${root}/etc/lockmaster.toml`;
      const toml = MINIMAL_TOML.replace('data_dir = "/var/lib/lockmaster"', `data_dir = "${root}/data"`);
      writeFileSync(file, `${toml}\n[security]\nmaster_key_file = "${root}/etc/master.key"\n`);
      expect(codeOf(() => loadConfig({ path: file, env: {} }))).toBe('CONFIG_INVALID');
      writeFileSync(file, `${toml}\n[security]\nmaster_key_file = "${root}/etc/kdir/master.key"\n`);
      expect(codeOf(() => loadConfig({ path: file, env: {} }))).toBe('CONFIG_INVALID');
    } finally {
      cleanup();
    }
  });

  it('résout « lien/.. » comme le noyau : depuis la cible réelle du lien, pas lexicalement', () => {
    const { root, cleanup } = makeTree({ 'data/sub/keep': '', 'data/master.key': 'x', 'etc/keep': '' });
    try {
      symlinkSync(`${root}/data/sub`, `${root}/etc/lnk`);
      const file = `${root}/etc/lockmaster.toml`;
      const toml = MINIMAL_TOML.replace('data_dir = "/var/lib/lockmaster"', `data_dir = "${root}/data"`);
      writeFileSync(file, `${toml}\n[security]\nmaster_key_file = "${root}/etc/lnk/../master.key"\n`);
      expect(codeOf(() => loadConfig({ path: file, env: {} }))).toBe('CONFIG_INVALID');
    } finally {
      cleanup();
    }
  });

  it("résout la cible relative d'un lien pendant depuis le dossier RÉEL qui le contient", () => {
    const { root, cleanup } = makeTree({ 'opt/data/keep': '', 'opt/cfg/keep': '', 'etc/keep': '' });
    try {
      symlinkSync(`${root}/opt/cfg`, `${root}/etc/lockmaster`);
      symlinkSync('../data/master.key', `${root}/opt/cfg/master.key`);
      const file = `${root}/etc/lockmaster.toml`;
      const toml = MINIMAL_TOML.replace('data_dir = "/var/lib/lockmaster"', `data_dir = "${root}/opt/data"`);
      writeFileSync(file, `${toml}\n[security]\nmaster_key_file = "${root}/etc/lockmaster/master.key"\n`);
      expect(codeOf(() => loadConfig({ path: file, env: {} }))).toBe('CONFIG_INVALID');
    } finally {
      cleanup();
    }
  });

  it("indique la clé fautive dans le message d'erreur", () => {
    const { file, cleanup } = withFile(`${MINIMAL_TOML}\n[http]\nrequest_timeout = "15 minutes"\n`);
    try {
      loadConfig({ path: file, env: {} });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('http.request_timeout');
    } finally {
      cleanup();
    }
  });
});
