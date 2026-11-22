import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Les mises à jour de versions arrivent sur la branche d'intégration (dev), jamais directement sur
// main qui ne porte que les versions publiées (CONVENTIONS.md §Flux git).

const text = readFileSync(join(import.meta.dirname, '../../../.github/dependabot.yml'), 'utf8');
const sections = text.split(/^ {2}- package-ecosystem: /m).slice(1);

describe('configuration de Dependabot', () => {
  it('chaque écosystème vise dev', () => {
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(section, section.split('\n')[0]).toMatch(/^ {4}target-branch: "dev"$/m);
    }
  });

  it('les actions github/codeql-action sont mises à jour ensemble (init et analyze à la même version)', () => {
    const actions = sections.find((section) => section.startsWith('"github-actions"'));
    expect(actions).toBeDefined();
    expect(actions).toMatch(
      /^ {4}groups:\n(?: {6}#.*\n)* {6}codeql-action:\n {8}patterns:\n {10}- "github\/codeql-action\*"$/m,
    );
  });
});
