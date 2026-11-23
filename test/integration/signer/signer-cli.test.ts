import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { generateOpenPgpKey } from '../../../src/crypto/openpgp.js';
import { encodeFrame } from '../../../src/domain/signer-protocol.js';
import { loadSignerConfig } from '../../../src/signer/config.js';
import { startSigner } from '../../../src/signer/server.js';
import { LogCapture } from '../../helpers/deps.js';
import { rawExchange, signerCli, signerInstallation } from '../../helpers/signer.js';

// CLI locale du signataire (sous le compte lockmaster-signer) : `signer keys list` (parties publiques)
// et `signer log` (journal, chaîne vérifiée avant affichage).

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function withKey() {
  const install = signerInstallation();
  cleanups.push(install.cleanup);
  expect((await signerCli(['init', '--config', install.config])).code).toBe(0);
  const signer = await startSigner(loadSignerConfig({ path: install.config, env: {} }), {
    logDestination: new LogCapture(),
    generators: {
      async openpgp({ name, date }) {
        const key = await generateOpenPgpKey({ name, type: 'ed25519', date, validityDays: 730 });
        return { ...key, expiresAt: date.getTime() + 730 * 86_400_000 };
      },
      apk: () => Promise.reject(new Error('inutilisé')),
    },
  });
  cleanups.push(() => signer.stop());
  const identity = {
    repoName: 'debian-12',
    repoFormat: 'deb',
    originLabel: 'lockmaster-debian-12',
    allowedNames: ['*'],
  };
  const data = await rawExchange(
    install.socket,
    encodeFrame({ op: 'generate-key', purpose: 'repo', kind: 'openpgp', identity }),
  );
  const keyId = JSON.parse(data.subarray(4).toString('utf8')).result.key.id as string;
  return { install, keyId };
}

describe('lockmaster signer keys list / log', () => {
  it('keys list : identifiant, type, usage, état, dépôt et empreinte, jamais de clé privée', async () => {
    const { install, keyId } = await withKey();
    const result = await signerCli(['keys', 'list', '--config', install.config]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(keyId);
    expect(result.stdout).toMatch(/openpgp\s+repo\s+active\s+debian-12\s+[0-9a-f]{40}/);
    expect(result.stdout).not.toContain('PRIVATE');
  });

  it('log : chaîne vérifiée, puis les entrées', async () => {
    const { install, keyId } = await withKey();
    const result = await signerCli(['log', '--config', install.config]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/chaîne vérifiée : 1 entrée/);
    expect(result.stdout).toMatch(new RegExp(`1\\s+\\S+\\s+key-generate\\s+done\\s+${keyId}`));
  });

  it('log : chaîne rompue signalée, code de sortie 1', async () => {
    const { install } = await withKey();
    const db = new Database(join(install.dataDir, 'signer.db'));
    db.exec("DROP TRIGGER signature_log_no_update; UPDATE signature_log SET outcome = 'refused' WHERE seq = 1;");
    db.close();
    const result = await signerCli(['log', '--config', install.config]);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/chaîne rompue à l'entrée 1/);
  });

  it('refuse des options de tranche invalides (64)', async () => {
    const { install } = await withKey();
    expect((await signerCli(['log', '--limit', '0', '--config', install.config])).code).toBe(64);
    expect((await signerCli(['log', '--after', '-3', '--config', install.config])).code).toBe(64);
  });
});
