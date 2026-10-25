import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { readSecretFile } from '../../../src/config/secret-file.js';
import { makeTree, runScript } from '../../helpers/run-script.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function emptyDir(): string {
  const { root, cleanup } = makeTree({});
  cleanups.push(cleanup);
  return root;
}

describe('scripts/dev-init.mjs (pnpm dev:init)', () => {
  it('écrit une configuration de développement valide et une clé maîtresse jetable hors de data_dir', () => {
    const root = emptyDir();
    const result = runScript('scripts/dev-init.mjs', [], root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    const config = loadConfig({ path: join(root, 'lockmaster.dev.toml'), env: {} });
    expect(config.server.data_dir).toBe(join(root, '.data'));
    expect(config.security.master_key_file).toBe(join(root, '.data-keys', 'dev-master.key'));
    expect(config.http.listen.host).toBe('127.0.0.1');

    const key = Buffer.from(readSecretFile(config.security.master_key_file).toString('utf8').trim(), 'base64');
    expect(key).toHaveLength(32);
    expect(statSync(config.security.master_key_file).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, '.data')).mode & 0o777).toBe(0o700);
  });

  it("ne remplace ni la configuration ni la clé d'une exécution précédente", () => {
    const root = emptyDir();
    runScript('scripts/dev-init.mjs', [], root);
    const keyPath = join(root, '.data-keys', 'dev-master.key');
    const before = readFileSync(keyPath, 'utf8');
    const result = runScript('scripts/dev-init.mjs', [], root);
    expect(result.status).toBe(0);
    expect(readFileSync(keyPath, 'utf8')).toBe(before);
  });
});
