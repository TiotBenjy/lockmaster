// Utilitaires partagés par les hooks Claude Code du projet (Node >= 18, aucune dépendance).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Lit et parse le JSON reçu sur stdin. Retourne {} si vide ou invalide. */
export function readHookInput() {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Bloque l'action : le message sur stderr est renvoyé à Claude (code 2). */
export function block(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/** Racine du checkout (principal ou worktree) contenant `start` : premier parent avec une entrée `.git`. */
export function repoRootOf(start) {
  let dir = resolve(start ?? process.cwd());
  // Fichier pas encore créé (Write) : remonter jusqu'au premier dossier existant.
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Chemin d'un fichier relatif à la racine de SON checkout, avec des « / ».
 * Fonctionne dans les worktrees (.claude/worktrees/<nom>/src/x.ts -> src/x.ts), où
 * $CLAUDE_PROJECT_DIR reste le checkout principal.
 */
export function relToProject(filePath, cwd) {
  if (!filePath) return '';
  const abs = isAbsolute(filePath) ? filePath : resolve(cwd ?? process.cwd(), filePath);
  const root = repoRootOf(dirname(abs)) ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  return relative(root, abs).replaceAll('\\', '/');
}

/** Exécute git dans `cwd` ; retourne la sortie (sans fin de ligne) ou null en cas d'échec. */
export function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 10_000 })
      .replace(/\n$/, '');
  } catch {
    return null;
  }
}

/** État git du répertoire : worktree lié ou checkout principal, branche courante, checkout principal. */
export function gitState(cwd) {
  const gitDir = git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const commonDir = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!gitDir || !commonDir) return null;
  const branch = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']); // null si HEAD détachée
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  // Premier bloc de `git worktree list --porcelain` = checkout principal.
  const list = git(cwd, ['worktree', 'list', '--porcelain']) ?? '';
  const first = list.split('\n\n')[0] ?? '';
  const mainPath = first.match(/^worktree (.+)$/m)?.[1] ?? null;
  const mainBranch = first.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null;
  return { isLinkedWorktree: gitDir !== commonDir, branch, top, mainPath, mainBranch };
}

/** Branches de travail autorisées pour l'agent (worktrees natifs de Claude Code : worktree-<nom>). */
export const WORK_BRANCH = /^worktree-(feat|fix|sec|refactor|perf|docs|test|build|ci|chore)-[a-z0-9][a-z0-9-]{1,60}$/;

/** Clé git config qui mémorise la branche source d'une branche de worktree. */
export const sourceKey = (branch) => `branch.${branch}.claudesource`;

/**
 * Mémorise la branche source d'un worktree (branche du checkout principal au moment de la création,
 * `worktree.baseRef = "head"`). Idempotent. Retourne { ok, source, reason }.
 */
export function recordSource(cwd) {
  const st = gitState(cwd);
  if (!st?.isLinkedWorktree || !st.branch) return { ok: false, reason: 'pas un worktree sur une branche' };
  const existing = git(cwd, ['config', '--get', sourceKey(st.branch)]);
  if (existing) return { ok: true, source: existing };
  if (!st.mainBranch) return { ok: false, reason: 'le checkout principal est en HEAD détachée : branche source inconnue' };
  // La branche du worktree doit partir de la branche source (même point ou descendante).
  if (git(cwd, ['merge-base', '--is-ancestor', st.mainBranch, st.branch]) === null) {
    return { ok: false, reason: `la branche ${st.branch} ne part pas de ${st.mainBranch}` };
  }
  if (git(cwd, ['config', sourceKey(st.branch), st.mainBranch]) === null) {
    return { ok: false, reason: 'écriture de la configuration git impossible' };
  }
  return { ok: true, source: st.mainBranch };
}

// CLAUDE.md §Style d'écriture : caractères typographiques caractéristiques des textes générés.
// Écrits en séquences d'échappement pour que ce fichier en soit lui-même exempt.
const AI_TYPO_NAMES = new Map([
  ['\u2014', 'tiret long'],
  ['\u2013', 'tiret moyen'],
  ['\u2015', 'barre horizontale'],
  ['\u2026', 'points de suspension en un caractère (écrire ...)'],
  ['\u201c', 'guillemet anglais courbe'],
  ['\u201d', 'guillemet anglais courbe'],
  ['\u2018', 'apostrophe courbe ouvrante'],
  ['\u2022', 'puce'],
  ['\u202f', 'espace fine insécable'],
  ['\u2009', 'espace fine'],
  ['\u200b', 'espace de largeur nulle'],
]);
export const AI_TYPO = /[\u2013\u2014\u2015\u2018\u201c\u201d\u2022\u2026\u202f\u2009\u200b\u2190-\u21ff\u2600-\u27bf\u{1F000}-\u{1FAFF}]/u;

/** Liste lisible des caractères interdits présents dans `text` (vide si aucun). */
export function aiTypoFindings(text) {
  const found = new Map();
  const lines = String(text ?? '').split('\n');
  lines.forEach((line, i) => {
    for (const ch of line) {
      if (!AI_TYPO.test(ch)) continue;
      const cp = `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
      const name = AI_TYPO_NAMES.get(ch) ?? (/[\u2190-\u21ff]/u.test(ch) ? 'flèche' : 'emoji ou pictogramme');
      if (!found.has(cp)) found.set(cp, `${cp} ${name} (ligne ${i + 1})`);
    }
  });
  return [...found.values()];
}
