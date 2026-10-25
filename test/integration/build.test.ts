import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };
import { REPO_ROOT, runScript } from '../helpers/run-script.js';

// `pnpm build` (scripts/build.mjs) : deux bundles distincts (application, signataire, ADR-0009),
// better-sqlite3 externe copié avec son module natif, licences tierces jointes.

let out: string;
beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'lockmaster-dist-'));
  const result = runScript('scripts/build.mjs', [`--out=${out}`]);
  if (result.status !== 0) throw new Error(`build en échec : ${result.stderr}`);
}, 120_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

const run = (file: string, args: string[]) =>
  spawnSync(process.execPath, [join(out, file), ...args], { cwd: REPO_ROOT, encoding: 'utf8', shell: false });

describe('scripts/build.mjs', () => {
  it("produit le bundle de l'application, exécutable", () => {
    const result = run('lockmaster.mjs', ['--version']);
    expect(result.stdout.trim()).toBe(packageJson.version);
    expect(run('lockmaster.mjs', ['--help']).stdout).toContain('lockmaster serve');
  });

  it('produit le bundle du signataire, exécutable', () => {
    expect(run('lockmaster-signer.mjs', ['--help']).stdout).toContain('lockmaster signer init');
  });

  it("n'embarque aucun code du signataire dans l'application, ni de serveur HTTP dans le signataire", () => {
    const app = readFileSync(join(out, 'lockmaster.mjs'), 'utf8');
    const signer = readFileSync(join(out, 'lockmaster-signer.mjs'), 'utf8');
    expect(app).not.toContain('signer.request_refused');
    expect(signer).toContain('signer.request_refused');
    expect(signer).not.toContain('fastify');
    expect(signer).not.toContain('@fastify/helmet');
  });

  it('copie better-sqlite3 et son module natif, utilisables par le bundle', () => {
    expect(existsSync(join(out, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'))).toBe(true);
    expect(existsSync(join(out, 'node_modules/better-sqlite3/prebuilds'))).toBe(false);
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import D from 'better-sqlite3'; console.log(new D(':memory:').prepare('select 1 as x').get().x)",
      ],
      { cwd: out, encoding: 'utf8', shell: false },
    );
    expect(probe.stdout.trim()).toBe('1');
  });

  it('joint les licences des dépendances de production', () => {
    const licenses = readFileSync(join(out, 'THIRD-PARTY-LICENSES.txt'), 'utf8');
    for (const name of ['fastify', 'better-sqlite3', 'zod', 'pino', 'smol-toml']) expect(licenses).toContain(name);
    expect(readFileSync(join(out, 'LICENSE'), 'utf8')).toContain('MIT');
  });
});
