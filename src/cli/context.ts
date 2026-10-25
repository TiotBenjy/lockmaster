import { loadConfig, resolveConfigPath } from '../config/load.js';
import type { Config } from '../config/schema.js';

// Contexte passé à chaque commande : environnement, identité du processus, sorties, options.

export interface Output {
  write(text: string): unknown;
}

export interface CliRuntime {
  env: Readonly<Record<string, string | undefined>>;
  uid: number;
  stdout: Output;
  stderr: Output;
}

export interface CommandContext {
  runtime: CliRuntime;
  options: Readonly<Record<string, string | boolean | undefined>>;
}

export function configPathOf(ctx: CommandContext): string {
  const cli = ctx.options['config'];
  return resolveConfigPath(typeof cli === 'string' ? cli : undefined, ctx.runtime.env);
}

export function loadContextConfig(ctx: CommandContext): Config {
  return loadConfig({ path: configPathOf(ctx), env: ctx.runtime.env });
}
