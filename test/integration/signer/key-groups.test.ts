import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { signerConfigSchema } from '../../../src/signer/config.js';
import { keyGroups } from '../../../src/signer/server.js';
import { signerCli, signerInstallation } from '../../helpers/signer.js';

// La clé du signataire ne doit jamais être admise si elle est lisible par le groupe du socket
// (lockmaster-sign, partagé avec l'application) : `server.socket_group`, ou, s'il est vide, le
// groupe du dossier setgid (sinon egid) ; en cas de doute, seul root est admis.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ownGid = process.getgid?.() ?? 0;

function config(socketGroup: string, mode: number | 'absent') {
  const root = mkdtempSync(join(tmpdir(), 'lockmaster-keygroups-'));
  dirs.push(root);
  const dir = join(root, 'run');
  if (mode !== 'absent') {
    mkdirSync(dir);
    chmodSync(dir, mode);
  }
  return signerConfigSchema.parse({ server: { socket: join(dir, 'sign.sock'), socket_group: socketGroup } });
}

describe('keyGroups', () => {
  it('exclut le groupe désigné par socket_group', () => {
    expect(keyGroups(config(String(ownGid), 0o750))).not.toContain(ownGid);
  });

  it.each([
    ['dossier setgid', 0o2750],
    ['dossier sans setgid (le socket prend le groupe principal)', 0o750],
  ] as const)('socket_group vide : exclut le groupe effectif du socket (%s)', (_label, mode) => {
    expect(keyGroups(config('', mode))).not.toContain(ownGid);
  });

  it("n'admet que root si le groupe ou le dossier est introuvable", () => {
    expect(keyGroups(config('', 'absent'))).toEqual([0]);
    expect(keyGroups(config('groupe-inexistant-lockmaster', 0o750))).toEqual([0]);
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
