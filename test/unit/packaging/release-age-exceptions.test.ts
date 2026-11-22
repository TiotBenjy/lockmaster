import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Exceptions au délai de 7 jours de pnpm (CONVENTIONS.md §Contenu externe) : chaque entrée de
// minimumReleaseAgeExclude est justifiée par une ligne de commentaire structurée, produite par
// scripts/security-exception.mjs et validée par le porteur :
//   #  - <paquet>@<version> : <GHSA, ...> ; CVSS <score> | KEV ; retrait le <AAAA-MM-JJ>
// Ce test échoue dès que la date de retrait est passée : l'exception doit alors être retirée.

const workspace = readFileSync(join(import.meta.dirname, '../../../pnpm-workspace.yaml'), 'utf8');
const METADATA =
  /^# {2}- (\S+) : (GHSA-[\w-]+(?:, GHSA-[\w-]+)*) ; (?:CVSS (\d+(?:\.\d)?)|KEV) ; retrait le (\d{4}-\d{2}-\d{2})$/;
const MIN_SCORE = 8.5;

const entries = (/^minimumReleaseAgeExclude:\n((?: {2}- .+\n)+)/m.exec(workspace)?.[1] ?? '')
  .split('\n')
  .filter(Boolean)
  .map((line) => line.replace(/^ {2}- /, ''));
const metadata = workspace
  .split('\n')
  .map((line) => METADATA.exec(line))
  .filter((match): match is RegExpExecArray => match !== null)
  .map(([, spec, , score, until]) => ({ spec: spec ?? '', score: score === undefined ? null : Number(score), until }));

describe('exceptions au délai minimumReleaseAge', () => {
  it('chaque exception a sa ligne de justification, et chaque justification son exception', () => {
    expect(metadata.map(({ spec }) => spec).sort()).toEqual([...entries].sort());
  });

  it(`seulement pour un avis de CVSS au moins ${MIN_SCORE} ou présent dans KEV`, () => {
    for (const { spec, score } of metadata) {
      if (score !== null) expect(score, spec).toBeGreaterThanOrEqual(MIN_SCORE);
    }
  });

  it('aucune exception dont la date de retrait est passée (la retirer de pnpm-workspace.yaml)', () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const { spec, until } of metadata) expect(until && until >= today, `${spec} : retrait le ${until}`).toBe(true);
  });
});
