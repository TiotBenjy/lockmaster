import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Le postinstall de lockmaster-repo tourne en root dans /srv/lockmaster-repo, qui appartient au
// publieur (compte non privilégié) : root ne doit jamais y suivre un lien posé par ce compte.
// Les fonctions du script (entre ses marqueurs) sont exécutées ici sous le compte courant.

const SCRIPT = join(import.meta.dirname, '../../packaging/scripts/repo/postinstall.sh');
const functions = /# >>> fonctions.*\n([\s\S]*?)# <<< fonctions/.exec(readFileSync(SCRIPT, 'utf8'))?.[1] ?? '';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lockmaster-repo-postinst-'));
  dirs.push(dir);
  return dir;
}

const user = userInfo().username;
const group = spawnSync('id', ['-gn'], { encoding: 'utf8' }).stdout.trim();

function run(call: string) {
  const file = join(sandbox(), 'functions.sh');
  writeFileSync(file, `set -e\n${functions}\n${call}\n`);
  return spawnSync('sh', [file], { encoding: 'utf8', shell: false });
}

const mode = (path: string) => statSync(path).mode & 0o7777;

describe('postinstall de lockmaster-repo', () => {
  it('contient ses fonctions entre marqueurs', () => {
    expect(functions).toMatch(/create_repo_tree\(\)/);
    expect(functions).toMatch(/check_root_owned\(\)/);
  });

  it('crée la racine et ses deux dossiers en 2750 quand la racine est absente', () => {
    const root = join(sandbox(), 'srv', 'lockmaster-repo');
    const result = run(`create_repo_tree '${root}' '${user}' '${group}'`);
    expect(result.status, result.stderr).toBe(0);
    for (const dir of [root, join(root, 'public'), join(root, 'private')]) expect(mode(dir)).toBe(0o2750);
  });

  it('ne suit pas un lien posé par le publieur dans une racine existante', () => {
    const base = sandbox();
    const victim = join(base, 'victim');
    mkdirSync(victim);
    chmodSync(victim, 0o700);
    const root = join(base, 'lockmaster-repo');
    mkdirSync(root);
    symlinkSync(victim, join(root, 'public'));
    symlinkSync(join(base, 'absent'), join(root, 'private'));
    const result = run(`create_repo_tree '${root}' '${user}' '${group}'`);
    expect(result.status, result.stderr).toBe(0);
    expect(mode(victim)).toBe(0o700);
    expect(result.stderr).toMatch(/lien symbolique/);
  });

  it('signale un home ou authorized_keys qui ne sont pas à root', () => {
    const home = sandbox();
    const result = run(`check_root_owned '${home}'`);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/doit appartenir à root/);
  });
});
