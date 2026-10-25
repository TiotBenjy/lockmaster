import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { signerConfigSchema } from '../../../src/signer/config.js';
import { keyGroups } from '../../../src/signer/server.js';
import { signerCli, signerInstallation } from '../../helpers/signer.js';

// La clé du signataire ne doit jamais être admise si elle est lisible par le groupe du socket
// (lockmaster-sign, partagé avec l'application) : ce groupe est celui du dossier s'il est setgid,
// sinon le groupe principal du signataire ; en cas de doute, le groupe principal est exclu.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configWithSocketDir(mode: number | 'absent') {
  const root = mkdtempSync(join(tmpdir(), 'lockmaster-keygroups-'));
  dirs.push(root);
  const dir = join(root, 'run');
  if (mode !== 'absent') {
    mkdirSync(dir);
    chmodSync(dir, mode);
  }
  return signerConfigSchema.parse({ socket: { path: join(dir, 'sign.sock') } });
}

describe('keyGroups', () => {
  it.each([
    ['dossier setgid', 0o2750],
    ['dossier sans setgid (le socket prend le groupe principal)', 0o750],
  ] as const)('exclut le groupe effectif du socket : %s', (_label, mode) => {
    expect(keyGroups(configWithSocketDir(mode))).not.toContain(process.getgid?.());
  });

  it('exclut le groupe principal quand le dossier du socket est introuvable', () => {
    expect(keyGroups(configWithSocketDir('absent'))).toEqual([0]);
  });
});

describe('--socket vide', () => {
  it('est une erreur de configuration (78), pas une erreur inattendue', async () => {
    const install = signerInstallation();
    dirs.push(install.root);
    expect((await signerCli(['init', '--config', install.config])).code).toBe(0);
    expect((await signerCli(['serve', '--socket', '', '--config', install.config])).code).toBe(78);
  });
});
