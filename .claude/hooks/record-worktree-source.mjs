// SessionStart et PostToolUse (EnterWorktree) : mémorise la branche source d'un worktree de l'agent
// dès qu'il y entre (git config branch.<branche>.claudesource = branche du checkout principal).
// N'empêche rien : git-guard.mjs refuse ensuite commits et merges si la source est inconnue.
import { gitState, readHookInput, recordSource } from './lib.mjs';

const input = readHookInput();
// PostToolUse(EnterWorktree) : le chemin du worktree est dans la réponse ou l'entrée de l'outil.
const candidates = [
  input.tool_response?.worktreePath,
  input.tool_response?.path,
  input.tool_input?.path,
  input.cwd,
].filter((p) => typeof p === 'string' && p.length > 0);

for (const dir of candidates) {
  const st = gitState(dir);
  if (!st?.isLinkedWorktree) continue;
  const rec = recordSource(dir);
  const msg = rec.ok
    ? `Worktree ${st.branch} : branche source = ${rec.source} (intégration par « git merge --ff-only ${st.branch} » depuis le checkout principal sur ${rec.source}).`
    : `Attention : branche source du worktree non mémorisée (${rec.reason}). Les commits y seront refusés.`;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? 'SessionStart', additionalContext: msg } })}\n`);
  break;
}
