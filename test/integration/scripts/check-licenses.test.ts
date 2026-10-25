import { afterEach, describe, expect, it } from 'vitest';
import { makeTree, runScript } from '../../helpers/run-script.js';

const SCRIPT = 'scripts/check-licenses.mjs';
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Écrit une sortie fictive de `pnpm licenses list --prod --json` et lance le contrôle dessus. */
function check(report: Record<string, Array<{ name: string; versions: string[] }>>) {
  const { root, cleanup } = makeTree({ 'licenses.json': JSON.stringify(report) });
  cleanups.push(cleanup);
  return runScript(SCRIPT, [`--input=${root}/licenses.json`]);
}

const pkg = (name: string) => ({ name, versions: ['1.0.0'] });

describe('scripts/check-licenses.mjs (CLAUDE.md §Licence)', () => {
  it('accepte les licences de la liste blanche', () => {
    const result = check({
      MIT: [pkg('a')],
      ISC: [pkg('b')],
      'BSD-2-Clause': [pkg('c')],
      'BSD-3-Clause': [pkg('d')],
      '0BSD': [pkg('e')],
      'Apache-2.0': [pkg('f')],
      '(MIT OR GPL-3.0)': [pkg('g')],
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('accepte openpgp en LGPL-3.0-or-later, et lui seul', () => {
    expect(check({ 'LGPL-3.0-or-later': [pkg('openpgp')] }).status).toBe(0);
    const result = check({ 'LGPL-3.0-or-later': [pkg('autre')] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('autre');
  });

  it.each(['GPL-3.0', 'AGPL-3.0-only', 'SSPL-1.0', 'MPL-2.0', 'Unknown', '(MIT AND GPL-2.0)'])(
    'refuse la licence %s',
    (license) => {
      const result = check({ [license]: [pkg('fautif')] });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('fautif');
      expect(result.stderr).toContain(license);
    },
  );

  it('accepte les dépendances de production actuelles du dépôt', () => {
    const result = runScript(SCRIPT, []);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
