import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/run-script.js';

// Lanceur packaging/bin/lockmaster (paquets : /usr/bin/lockmaster -> /usr/lib/lockmaster/bin/lockmaster ;
// image : /app/bin/lockmaster). Il exécute le Node embarqué sur l'un des deux bundles.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Installation factice : node embarqué = node courant, bundles qui affichent leur nom et leurs arguments. */
function fakeInstall() {
  const root = mkdtempSync(join(tmpdir(), 'lockmaster-launcher-'));
  roots.push(root);
  mkdirSync(join(root, 'node/bin'), { recursive: true });
  mkdirSync(join(root, 'bin'));
  symlinkSync(process.execPath, join(root, 'node/bin/node'));
  for (const name of ['lockmaster.mjs', 'lockmaster-signer.mjs']) {
    writeFileSync(
      join(root, name),
      `console.log(JSON.stringify(['${name}', ...process.argv.slice(2), process.execArgv]));\n`,
    );
  }
  copyFileSync(join(REPO_ROOT, 'packaging/bin/lockmaster'), join(root, 'bin/lockmaster'));
  chmodSync(join(root, 'bin/lockmaster'), 0o755);
  // Comme /usr/bin/lockmaster dans les paquets : un lien vers le lanceur.
  mkdirSync(join(root, 'usr-bin'));
  symlinkSync(join(root, 'bin/lockmaster'), join(root, 'usr-bin/lockmaster'));
  return root;
}

function launch(path: string, args: string[]) {
  const result = spawnSync(path, args, { encoding: 'utf8', shell: false, env: { PATH: '/usr/bin:/bin' } });
  return JSON.parse(result.stdout) as [string, ...unknown[]];
}

describe('packaging/bin/lockmaster', () => {
  it("lance l'application avec les arguments tels quels, via le lien de /usr/bin", () => {
    const root = fakeInstall();
    const [entry, ...rest] = launch(join(root, 'usr-bin/lockmaster'), ['serve', '--config', 'a b.toml']);
    expect(entry).toBe('lockmaster.mjs');
    expect(rest.slice(0, 3)).toEqual(['serve', '--config', 'a b.toml']);
  });

  it('aiguille la sous-commande signer vers le bundle du signataire', () => {
    const root = fakeInstall();
    const [entry, ...rest] = launch(join(root, 'bin/lockmaster'), ['signer', 'serve', '--socket-activation']);
    expect(entry).toBe('lockmaster-signer.mjs');
    expect(rest.slice(0, 2)).toEqual(['serve', '--socket-activation']);
  });

  it('borne la mémoire du tas V8 (docs/01 §4)', () => {
    const root = fakeInstall();
    const app = launch(join(root, 'bin/lockmaster'), ['serve']);
    const signer = launch(join(root, 'bin/lockmaster'), ['signer', 'serve']);
    expect(JSON.stringify(app)).toContain('--max-old-space-size=');
    expect(JSON.stringify(signer)).toContain('--max-old-space-size=');
  });
});
