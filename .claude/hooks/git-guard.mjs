// PreToolUse (Bash) : flux git imposé à l'agent (CLAUDE.md §Flux git) :
//  - tout travail se fait dans un worktree natif de Claude Code (.claude/worktrees/<nom>,
//    branche worktree-<type>-<sujet>) ;
//  - commits LOCAUX uniquement, et seulement dans ces worktrees ;
//  - intégration = `git merge --ff-only <branche>` dans le checkout principal, et seulement si le
//    checkout principal est sur la BRANCHE SOURCE mémorisée de ce worktree ;
//  - jamais de push, jamais de --no-verify, rien qui réécrive ou change la branche du checkout principal.
// Ce hook complète l'isolation native des worktrees de Claude Code ; il ne remplace pas la revue humaine.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WORK_BRANCH, aiTypoFindings, block, git, gitState, readHookInput, recordSource, sourceKey } from './lib.mjs';

const input = readHookInput();
const cmd = String(input.tool_input?.command ?? '');
const cwd = input.cwd ?? process.cwd();

// Repère les invocations git (début de commande ou après ; && || |).
const invocations = [...cmd.matchAll(/(?:^|[;&|]\s*)git\s+([^;&|]*)/g)].map((m) => m[1].trim());
if (invocations.length === 0) process.exit(0);

const FLOW = 'Voir CLAUDE.md §Flux git (worktrees, commits locaux, merge --ff-only dans la branche source).';

if (/(^|[;&|]\s*)cd\s/.test(cmd) || /(^|\s)(GIT_DIR|GIT_WORK_TREE)=/.test(cmd)) {
  block(`Refusé : lance git directement depuis le bon répertoire, sans « cd » ni GIT_DIR/GIT_WORK_TREE. ${FLOW}`);
}

const st = gitState(cwd);
if (!st) process.exit(0); // pas un dépôt git : rien à contrôler

for (const inv of invocations) {
  const args = inv.split(/\s+/);
  if (args[0] === '-C' || args[0]?.startsWith('--git-dir') || args[0]?.startsWith('--work-tree')) {
    block(`Refusé : « git ${args[0]} » interdit ; exécute git depuis le répertoire concerné. ${FLOW}`);
  }
  const sub = args[0] ?? '';
  const rest = args.slice(1);

  if (sub === 'commit') {
    // CLAUDE.md §Style d'écriture : le message (-m, heredoc ou -F fichier) ne contient aucun tic d'IA.
    let message = cmd;
    const fileArg = rest.findIndex((a) => a === '-F' || a === '--file');
    if (fileArg >= 0 && rest[fileArg + 1]) {
      try {
        message += `\n${readFileSync(resolve(cwd, rest[fileArg + 1].replace(/^['"]|['"]$/g, '')), 'utf8')}`;
      } catch {
        /* fichier illisible : git échouera de lui-même */
      }
    }
    const findings = aiTypoFindings(message);
    if (findings.length > 0) {
      block(`Refusé : message de commit avec des caractères interdits (CLAUDE.md §Style d'écriture) :\n- ${findings.join('\n- ')}`);
    }
  }
  if (sub === 'push') block(`Refusé : aucun push. Les commits restent locaux ; l'utilisateur pousse lui-même. ${FLOW}`);
  if (rest.includes('--no-verify') || rest.includes('-n') && sub === 'commit') {
    block('Refusé : --no-verify interdit (les vérifications ne se contournent pas).');
  }

  if (st.isLinkedWorktree) {
    // ── Dans un worktree de l'agent ────────────────────────────────────────────────
    if (!st.branch || !WORK_BRANCH.test(st.branch)) {
      block(
        `Refusé : la branche du worktree (${st.branch ?? 'HEAD détachée'}) doit s'appeler ` +
          'worktree-<type>-<sujet> (types : feat, fix, sec, refactor, perf, docs, test, build, ci, chore) : ' +
          `crée le worktree avec un nom comme « feat-m3-publication-apt ». ${FLOW}`,
      );
    }
    const rec = recordSource(cwd);
    if (!rec.ok) block(`Refusé : branche source du worktree inconnue (${rec.reason}). ${FLOW}`);
    if (sub === 'merge') {
      const target = rest.filter((a) => !a.startsWith('-'));
      const okSource = target.length === 1 && target[0] === rec.source;
      if (!okSource && !rest.includes('--abort') && !rest.includes('--continue')) {
        block(`Refusé : dans ce worktree, seul « git merge ${rec.source} » (intégrer la branche source) est permis. ${FLOW}`);
      }
    }
    if (sub === 'switch' || (sub === 'checkout' && (rest.includes('-b') || rest.includes('-B')))) {
      block(`Refusé : ne change pas de branche dans un worktree ; crée un nouveau worktree. ${FLOW}`);
    }
    if (sub === 'commit') {
      // TDD (CLAUDE.md §Méthode) : un commit de comportement (feat, fix, sec, perf) qui modifie src/
      // doit modifier aussi des tests. refactor/docs/chore/build/ci/test : pas d'obligation.
      const type = st.branch.split('-')[1];
      const staged = (git(cwd, ['diff', '--cached', '--name-only']) ?? '').split('\n').filter(Boolean);
      const stagedAll = rest.includes('-a') || rest.includes('--all') || rest.some((a) => /^-[a-zA-Z]*a/.test(a))
        ? (git(cwd, ['diff', '--name-only', 'HEAD']) ?? '').split('\n').filter(Boolean)
        : staged;
      const touchesSrc = stagedAll.some((f) => f.startsWith('src/'));
      const touchesTests = stagedAll.some((f) => f.startsWith('test/') || /\.test\.tsx?$/.test(f));
      if (['feat', 'fix', 'sec', 'perf'].includes(type) && touchesSrc && !touchesTests) {
        block(
          'Refusé (TDD) : ce commit modifie src/ sans aucun test. Écris d\'abord le test qui échoue, puis le code, ' +
            'et committe-les ensemble (ou committe le test seul en premier). Un pur refactoring se fait dans un worktree « refactor-... ».',
        );
      }
    }
    continue; // commit, add, rebase/reset de SA branche, stash... : permis dans son worktree
  }

  // ── Dans le checkout principal (appartient à l'utilisateur) ──────────────────────
  if (sub === 'commit') {
    block(`Refusé : pas de commit dans le checkout principal. Travaille dans un worktree (EnterWorktree). ${FLOW}`);
  }
  if (sub === 'merge') {
    if (rest.includes('--abort')) continue;
    const refs = rest.filter((a) => !a.startsWith('-'));
    if (refs.length !== 1 || !rest.includes('--ff-only')) {
      block(`Refusé : intégration uniquement par « git merge --ff-only worktree-<...> ». ${FLOW}`);
    }
    const branch = refs[0];
    const source = git(cwd, ['config', '--get', sourceKey(branch)]);
    if (!WORK_BRANCH.test(branch) || !source) {
      block(`Refusé : ${branch} n'est pas une branche de worktree de l'agent avec une branche source mémorisée. ${FLOW}`);
    }
    if (source !== st.branch) {
      block(`Refusé : ${branch} a pour branche source « ${source} », mais le checkout principal est sur « ${st.branch} ». ${FLOW}`);
    }
    continue;
  }
  if (sub === 'branch' && (rest.includes('-D') || rest.some((a) => /^-[a-zA-Z]*D/.test(a)) || rest.includes('--force'))) {
    block('Refusé : suppression forcée de branche interdite ; utiliser « git branch -d » (branche déjà intégrée).');
  }
  if (sub === 'branch' && (rest.includes('-d') || rest.includes('--delete'))) {
    const targets = rest.filter((a) => !a.startsWith('-'));
    if (targets.some((b) => !WORK_BRANCH.test(b))) block('Refusé : seules les branches worktree-<...> de l\'agent peuvent être supprimées.');
    continue;
  }
  if (sub === 'worktree' && rest[0] === 'remove') {
    const target = rest.filter((a) => !a.startsWith('-'))[1] ?? '';
    if (!/(^|\/)\.claude\/worktrees\/[^/]+\/?$/.test(target)) block('Refusé : seuls les worktrees sous .claude/worktrees/ peuvent être supprimés.');
    if (rest.includes('--force') || rest.includes('-f')) block('Refusé : « git worktree remove --force » interdit (travail non intégré ?).');
    continue;
  }
  if (['switch', 'checkout', 'reset', 'rebase', 'cherry-pick', 'revert', 'stash', 'pull', 'am', 'apply', 'clean', 'restore', 'tag'].includes(sub)) {
    block(`Refusé : « git ${sub} » modifierait le checkout principal de l'utilisateur. Travaille dans un worktree. ${FLOW}`);
  }
}
