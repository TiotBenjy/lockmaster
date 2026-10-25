import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Les tests de livrables (test/deliverables/) ne tournent qu'avec des conteneurs : ici, leur syntaxe
// et leur branchement dans la CI, pour qu'aucun ne soit oublié.

const ROOT = join(import.meta.dirname, '../../..');
const scripts = readdirSync(join(ROOT, 'test/deliverables')).filter((file) => file.endsWith('.sh'));
const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');

describe('test/deliverables', () => {
  it.each(scripts)('%s : syntaxe sh valide', (script) => {
    expect(() => execFileSync('sh', ['-n', join(ROOT, 'test/deliverables', script)], { stdio: 'pipe' })).not.toThrow();
  });

  it('la CI lance chaque test sur chaque distribution et chaque moteur', () => {
    expect(ci).toMatch(/distro: \[DEBIAN_12, DEBIAN_13, ROCKY_9, ROCKY_10\]/);
    expect(ci).toMatch(/test: \[packages, repo-package\]/);
    expect(ci).toMatch(/engine: \[podman, docker\]/);
    expect(ci).toContain('sh "test/deliverables/$TEST.sh" "$DISTRO"');
    expect(ci).toContain('sh test/deliverables/image.sh "$ENGINE"');
    for (const test of ['packages', 'repo-package', 'image']) expect(scripts).toContain(`${test}.sh`);
  });
});
