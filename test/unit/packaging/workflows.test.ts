import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// SEC-24 sur les workflows GitHub, en complément de test/security/SEC-24-supply-chain.test.ts
// (épinglage par SHA, pas de déclencheur à droits sur les PR) : permissions, jetons, injections,
// cache, publication.

const DIR = join(import.meta.dirname, '../../../.github/workflows');
const workflows = readdirSync(DIR)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({ file, text: readFileSync(join(DIR, file), 'utf8') }));
const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

/** Contenu des étapes `run:` (une ligne, ou bloc `|`, `|-`, `>`, `>-`... indenté sous la clé). */
function runBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  for (const [index, line] of lines.entries()) {
    const match = /^\s*(?:- )?run: ?(.*)$/.exec(line);
    if (!match) continue;
    if (!/^[|>][-+]?$/.test(match[1] ?? '')) {
      blocks.push(match[1] ?? '');
      continue;
    }
    // Le bloc s'arrête à la première ligne non vide qui n'est pas plus indentée que la clé run:.
    const keyColumn = line.indexOf('run:');
    const body: string[] = [];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() !== '' && next.length - next.trimStart().length <= keyColumn) break;
      body.push(next);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

describe('workflows GitHub (SEC-24)', () => {
  it('au moins les quatre workflows attendus', () => {
    expect(workflows.map(({ file }) => file).sort()).toEqual(
      expect.arrayContaining(['ci.yml', 'codeql.yml', 'dependency-review.yml', 'release.yml']),
    );
  });

  it.each(workflows)('$file : permissions globales en lecture seule', ({ text }) => {
    expect(text).toMatch(/^permissions:\n {2}contents: read\n(?! )/m);
  });

  it.each(workflows)('$file : aucune expression GitHub dans une étape run (injection)', ({ text }) => {
    for (const block of runBlocks(text)) expect(block).not.toContain('$' + '{{');
  });

  it('les étapes run sont bien lues (sinon le contrôle précédent passerait à vide)', () => {
    const ci = workflows.find(({ file }) => file === 'ci.yml')?.text ?? '';
    expect(runBlocks(ci).join('\n')).toContain('node scripts/check-test-guards.mjs');
    for (const style of ['|', '|-', '>', '>-']) {
      const expression = '$' + '{{ github.head_ref }}';
      const step = `    steps:\n      - run: ${style}\n          echo "${expression}"\n`;
      expect(runBlocks(step)[0], style).toContain('$' + '{{');
    }
  });

  // Droits en écriture permis, par workflow ; tout autre (ou write-all) est refusé.
  const WRITES: Record<string, string[]> = { 'codeql.yml': ['security-events'], 'release.yml': ['packages'] };
  it.each(workflows)('$file : droits en écriture limités à la liste blanche', ({ file, text }) => {
    expect(text).not.toMatch(/write-all/);
    // Forme en ligne refusée : seules les permissions écrites une par ligne sont analysées.
    expect(text).not.toMatch(/permissions:\s*\{/);
    const writes = [...text.matchAll(/^\s+([a-z-]+): write(?:\s+#.*)?$/gm)].map(([, scope]) => scope);
    expect([...new Set(writes)].sort()).toEqual(WRITES[file] ?? []);
  });

  it.each(workflows)('$file : checkout sans jeton persistant, aucun cache', ({ text }) => {
    expect(count(text, /uses: actions\/checkout@/g)).toBe(count(text, /persist-credentials: false/g));
    expect(count(text, /uses: actions\/setup-node@/g)).toBe(count(text, /package-manager-cache: false/g));
    expect(text).not.toMatch(/^\s*cache:|actions\/cache@/m);
  });

  it('écriture dans le registre et jeton OIDC réservés à release.yml, sous environnement protégé', () => {
    for (const { file, text } of workflows) {
      if (file === 'release.yml') continue;
      expect(text, file).not.toMatch(/packages: write|id-token: write|secrets\./);
    }
    const release = workflows.find(({ file }) => file === 'release.yml')?.text ?? '';
    expect(release).toMatch(/^ {4}environment: release$/m);
  });

  it('release.yml ne publie qu un tag de version exacte posé sur main', () => {
    const release = workflows.find(({ file }) => file === 'release.yml')?.text ?? '';
    expect(release).toContain("grep -Eq '^v[0-9]+\\.[0-9]+\\.[0-9]+$'");
    expect(release).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(release).toContain('sh test/deliverables/image.sh podman');
  });

  it('release.yml repasse toutes les gardes de la CI avant de construire l image', () => {
    const release = workflows.find(({ file }) => file === 'release.yml')?.text ?? '';
    const image = release.indexOf('- run: pnpm image');
    expect(image).toBeGreaterThan(0);
    for (const guard of [
      'node scripts/check-forbidden.mjs',
      'node scripts/check-test-guards.mjs --base=',
      'node scripts/check-contracts.mjs',
      'node scripts/check-licenses.mjs',
      'pnpm audit --audit-level moderate',
      '- run: pnpm test',
    ]) {
      const position = release.indexOf(guard);
      expect(position, guard).toBeGreaterThan(0);
      expect(position, guard).toBeLessThan(image);
    }
  });
});
