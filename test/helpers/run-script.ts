import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

export interface ScriptResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Lance un script Node du dépôt (scripts/*.mjs) dans un processus séparé. */
export function runScript(script: string, args: readonly string[], cwd = REPO_ROOT): ScriptResult {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, script), ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Crée une arborescence temporaire à partir d'un dictionnaire chemin -> contenu. */
export function makeTree(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'lockmaster-test-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
