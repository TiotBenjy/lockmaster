// Stop : avant de rendre la main, si du code a changé, exécute `pnpm check` et les tests
// unitaires. En cas d'échec, Claude est renvoyé au travail avec la sortie (code 2).
// Ne s'exécute pas en boucle : respecte stop_hook_active.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readHookInput, repoRootOf } from './lib.mjs';

const input = readHookInput();
if (input.stop_hook_active) process.exit(0);

// Dans un worktree, $CLAUDE_PROJECT_DIR reste le checkout principal : on vérifie là où Claude travaille.
const root = repoRootOf(input.cwd ?? process.cwd()) ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
if (!existsSync(join(root, 'package.json')) || !existsSync(join(root, 'node_modules'))) process.exit(0);

const run = (cmd, args, timeout) =>
  execFileSync(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout, encoding: 'utf8' });

// Y a-t-il des changements dans le code ou les tests ?
let changed = '';
try {
  changed = run(
    'git',
    ['status', '--porcelain', '--', 'src', 'test', 'packaging', 'deploy', 'package.json', 'pnpm-lock.yaml',
     'vitest.config.ts', 'biome.json', 'tsconfig.json', '.github'],
    10_000,
  );
} catch {
  process.exit(0); // pas un dépôt git : ne rien imposer
}
if (!changed.trim()) process.exit(0);

// SEC-19 : signaler toute modification d'un fichier qui encadre la sécurité (revue humaine requise).
const sensitive = changed
  .split('\n')
  .map((l) => l.slice(3).trim())
  .filter((f) => /^(test\/security\/|vitest\.config\.ts|biome\.json|\.github\/|packaging\/versions\.env|deploy\/nginx\/)/.test(f));
if (sensitive.length > 0) {
  process.stderr.write(
    `Fichiers sensibles modifiés (revue humaine requise, SEC-19) : ${sensitive.join(', ')}.\n` +
      'Si ce n\'était pas explicitement demandé, annule ces changements ; sinon, signale-les clairement à l\'utilisateur.\n',
  );
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
for (const [args, label] of [
  [['-s', 'check'], 'pnpm check'],
  [['-s', 'test'], 'pnpm test'],
]) {
  try {
    run(pnpm, args, 200_000); // 10 s (git) + 2 x 200 s < timeout du hook (480 s)
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    process.stderr.write(`« ${label} » échoue : corrige avant de terminer :\n${out.slice(-6000)}\n`);
    process.exit(2);
  }
}
