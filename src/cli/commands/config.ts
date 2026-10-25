import { type CommandContext, configPathOf, loadContextConfig } from '../context.js';

// `lockmaster config check|show` : valide la configuration ; affiche la configuration effective.
// Elle ne contient aucun secret (seulement des chemins *_file), docs/08 §4.

export async function configCheckCommand(ctx: CommandContext): Promise<number> {
  loadContextConfig(ctx);
  ctx.runtime.stdout.write(`configuration valide : ${configPathOf(ctx)}\n`);
  return 0;
}

export async function configShowCommand(ctx: CommandContext): Promise<number> {
  ctx.runtime.stdout.write(`${JSON.stringify(loadContextConfig(ctx), null, 2)}\n`);
  return 0;
}
