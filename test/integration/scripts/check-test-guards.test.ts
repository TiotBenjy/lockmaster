import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTree, runScript } from '../../helpers/run-script.js';

const SCRIPT = 'scripts/check-test-guards.mjs';
// Les modificateurs interdits sont assemblés à l'exécution : ce fichier ne doit pas lui-même
// déclencher les gardes qu'il teste.
const call = (base: string, modifier: string) => `${base}.${modifier}`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tree(files: Record<string, string>): string {
  const { root, cleanup } = makeTree(files);
  cleanups.push(cleanup);
  return root;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(result.stderr);
}

function gitRepo(files: Record<string, string>): string {
  const root = tree(files);
  git(root, ['init', '-q', '-b', 'base']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base']);
  return root;
}

describe('scripts/check-test-guards.mjs (SEC-19)', () => {
  it('accepte des tests ordinaires et affiche le nombre de tests de sécurité', () => {
    const root = tree({ 'test/security/SEC-01.test.ts': "it('a', () => {});\ntest('b', () => {});\n" });
    const result = runScript(SCRIPT, [`--root=${root}`]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('2');
  });

  it.each([
    ['test/unit/a.test.ts', `${call('it', 'only')}('a', () => {});\n`, '.only'],
    ['test/unit/a.test.ts', `${call('describe', 'only')}('a', () => {});\n`, '.only'],
    ['test/security/a.test.ts', `${call('it', 'skip')}('a', () => {});\n`, '.skip'],
    ['test/security/a.test.ts', `${call('it', 'todo')}('a');\n`, '.todo'],
    ['test/security/a.test.ts', `${call('it', 'skipIf')}(true)('a', () => {});\n`, 'skipIf'],
    ['test/security/a.test.ts', `${call('describe', 'runIf')}(false)('a', () => {});\n`, 'runIf'],
  ])('refuse %s avec %s (%#)', (path, content, label) => {
    const root = tree({ [path]: content });
    const result = runScript(SCRIPT, [`--root=${root}`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path);
    expect(result.stderr).toContain(label);
  });

  it('refuse une baisse du nombre de tests de sécurité par rapport à la base', () => {
    const root = gitRepo({ 'test/security/a.test.ts': "it('a', () => {});\nit('b', () => {});\n" });
    git(root, ['rm', '-q', 'test/security/a.test.ts']);
    const result = runScript(SCRIPT, [`--root=${root}`, '--base=base']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('2 -> 0');
  });

  it('accepte un nombre de tests de sécurité stable', () => {
    const root = gitRepo({ 'test/security/a.test.ts': "it('a', () => {});\n" });
    const result = runScript(SCRIPT, [`--root=${root}`, '--base=base']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('le dépôt lui-même respecte les règles', () => {
    const result = runScript(SCRIPT, []);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
