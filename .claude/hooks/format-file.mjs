// PostToolUse (Edit|Write) : formate et lint le fichier modifié avec Biome s'il est installé.
// Les erreurs de lint sont renvoyées à Claude (code 2) pour correction immédiate.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readHookInput, relToProject, repoRootOf } from './lib.mjs';

const filePath = readHookInput().tool_input?.file_path;
if (!filePath) process.exit(0);
// Racine du checkout du fichier (worktree compris) : on y cherche Biome.
const root = repoRootOf(dirname(filePath)) ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

const rel = relToProject(filePath);
if (!/\.(ts|tsx|mts|mjs|js|json|css)$/.test(rel)) process.exit(0);
if (rel.startsWith('.claude/') || rel.includes('node_modules/')) process.exit(0);

const biome = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'biome.cmd' : 'biome');
if (!existsSync(biome)) process.exit(0); // pas encore installé (avant M0)

try {
  execFileSync(biome, ['check', '--write', '--no-errors-on-unmatched', filePath], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 25_000,
  });
} catch (err) {
  const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.slice(0, 4000);
  process.stderr.write(`Biome signale des problèmes dans ${rel} :\n${out}\n`);
  process.exit(2);
}
