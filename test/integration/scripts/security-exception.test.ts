import { afterEach, describe, expect, it } from 'vitest';
import { makeTree, runScript } from '../../helpers/run-script.js';

// scripts/security-exception.mjs : propose les exceptions au délai de 7 jours pour les avis de CVSS au
// moins 8,5 ou présents dans KEV (CONVENTIONS.md §Contenu externe). Entrées fournies par fichiers ici ;
// sans option, le script lit `pnpm audit --json`, l'API des avis GitHub, le catalogue KEV et le registre.

// Même format que test/unit/packaging/release-age-exceptions.test.ts.
const METADATA =
  /^# {2}- (\S+) : (GHSA-[\w-]+(?:, GHSA-[\w-]+)*) ; (?:CVSS (\d+(?:\.\d)?)|KEV) ; retrait le (\d{4}-\d{2}-\d{2})$/;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Advisory {
  module: string;
  ghsa: string;
  patched: string;
  score: number | null;
  cves?: string[];
  published?: string;
}

function run(advisories: Advisory[], kev: string[] = []) {
  const audit = {
    advisories: Object.fromEntries(
      advisories.map((advisory, index) => [
        String(index + 1),
        {
          module_name: advisory.module,
          github_advisory_id: advisory.ghsa,
          patched_versions: advisory.patched,
          severity: 'high',
          findings: [{ version: '1.0.0', paths: [`.>${advisory.module}`] }],
        },
      ]),
    ),
    metadata: {},
  };
  const details = Object.fromEntries(
    advisories.map((advisory) => [advisory.ghsa, { score: advisory.score, cves: advisory.cves ?? [] }]),
  );
  const times = Object.fromEntries(
    advisories.map((advisory) => [
      `${advisory.module}@${advisory.patched.replace('>=', '')}`,
      advisory.published ?? '2026-11-20T08:00:00.000Z',
    ]),
  );
  const { root, cleanup } = makeTree({
    'audit.json': JSON.stringify(audit),
    'advisories.json': JSON.stringify(details),
    'kev.json': JSON.stringify(kev),
    'times.json': JSON.stringify(times),
  });
  cleanups.push(cleanup);
  return runScript('scripts/security-exception.mjs', [
    `--audit=${root}/audit.json`,
    `--advisories=${root}/advisories.json`,
    `--kev=${root}/kev.json`,
    `--times=${root}/times.json`,
    '--today=2026-11-22',
  ]);
}

const proposed = (stdout: string) => stdout.split('\n').filter((line) => METADATA.test(line));

describe('scripts/security-exception.mjs', () => {
  it("propose la ligne de justification et l'entrée exacte, retrait 7 jours après la publication", () => {
    const result = run([{ module: 'minimist', ghsa: 'GHSA-xvch-5gv4-984h', patched: '>=1.2.6', score: 9.8 }]);
    expect(result.status).toBe(0);
    expect(proposed(result.stdout)).toEqual([
      '#  - minimist@1.2.6 : GHSA-xvch-5gv4-984h ; CVSS 9.8 ; retrait le 2026-11-27',
    ]);
    expect(result.stdout).toContain('  - minimist@1.2.6');
  });

  it('applique le seuil de 8,5 : 8.5 proposé, 8.4 non (sauf KEV)', () => {
    const result = run(
      [
        { module: 'a', ghsa: 'GHSA-aaaa-aaaa-aaaa', patched: '>=2.0.1', score: 8.5 },
        { module: 'b', ghsa: 'GHSA-bbbb-bbbb-bbbb', patched: '>=3.1.0', score: 8.4 },
        { module: 'c', ghsa: 'GHSA-cccc-cccc-cccc', patched: '>=4.0.2', score: 7.5, cves: ['CVE-2026-0001'] },
      ],
      ['CVE-2026-0001'],
    );
    expect(result.status).toBe(0);
    expect(proposed(result.stdout)).toEqual([
      '#  - a@2.0.1 : GHSA-aaaa-aaaa-aaaa ; CVSS 8.5 ; retrait le 2026-11-27',
      '#  - c@4.0.2 : GHSA-cccc-cccc-cccc ; KEV ; retrait le 2026-11-27',
    ]);
    expect(result.stdout).toMatch(/b@3\.1\.0.*sous le seuil/);
  });

  it('ne propose rien si la version corrigée a déjà 7 jours (aucune exception nécessaire)', () => {
    const old = { module: 'd', ghsa: 'GHSA-dddd-dddd-dddd', patched: '>=1.0.1', score: 9.1 };
    const result = run([{ ...old, published: '2026-11-01T00:00:00.000Z' }]);
    expect(result.status).toBe(0);
    expect(proposed(result.stdout)).toEqual([]);
    expect(result.stdout).toMatch(/d@1\.0\.1.*aucune exception nécessaire/);
  });

  it("regroupe les avis d'un même paquet corrigés par la même version", () => {
    const result = run([
      { module: 'e', ghsa: 'GHSA-eeee-eeee-eee1', patched: '>=5.0.1', score: 9.0 },
      { module: 'e', ghsa: 'GHSA-eeee-eeee-eee2', patched: '>=5.0.1', score: 8.6 },
    ]);
    expect(proposed(result.stdout)).toEqual([
      '#  - e@5.0.1 : GHSA-eeee-eeee-eee1, GHSA-eeee-eeee-eee2 ; CVSS 9.0 ; retrait le 2026-11-27',
    ]);
  });

  it('signale une plage corrigée complexe sans inventer de version', () => {
    const result = run([
      { module: 'f', ghsa: 'GHSA-ffff-ffff-ffff', patched: '>=1.2.3 <2.0.0 || >=2.1.0', score: 9.5 },
    ]);
    expect(result.status).toBe(0);
    expect(proposed(result.stdout)).toEqual([]);
    expect(result.stdout).toMatch(/f.*version exacte à choisir/);
  });

  it("sans avis, l'indique et sort à 0", () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('aucun avis');
  });

  it("refuse une sortie d'audit illisible (sortie non nulle, sans proposition)", () => {
    const { root, cleanup } = makeTree({ 'audit.json': '{"pas": "un audit"}' });
    cleanups.push(cleanup);
    const result = runScript('scripts/security-exception.mjs', [`--audit=${root}/audit.json`, '--today=2026-11-22']);
    expect(result.status).not.toBe(0);
    expect(proposed(result.stdout)).toEqual([]);
  });
});
