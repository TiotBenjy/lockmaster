import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { z } from 'zod';
import { LockmasterError } from '../domain/errors.js';
import { applyEnvOverrides } from './env.js';
import { isInsideReally } from './real-path.js';
import { type Config, configSchema } from './schema.js';

export const DEFAULT_CONFIG_PATH = '/etc/lockmaster/lockmaster.toml';
const MAX_CONFIG_BYTES = 1024 * 1024;
// Clés de chemins (convention de nommage du fichier) : un chemin relatif l'est au dossier du fichier.
const PATH_KEY = /(^|_)(dir|file|path|socket|binary)$/;

type Env = Readonly<Record<string, string | undefined>>;

/** `--config` > LOCKMASTER_CONFIG > /etc/lockmaster/lockmaster.toml (docs/06 §4). */
export function resolveConfigPath(cliPath: string | undefined, env: Env): string {
  return cliPath || env['LOCKMASTER_CONFIG'] || DEFAULT_CONFIG_PATH;
}

/** Lit et analyse un fichier TOML de configuration, borné en taille. */
export function readTomlFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    if (statSync(path).size > MAX_CONFIG_BYTES) {
      throw new LockmasterError('CONFIG_INVALID', `${path} : fichier de configuration trop gros`);
    }
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof LockmasterError) throw error;
    const code = (error as NodeJS.ErrnoException).code ?? 'inconnue';
    throw new LockmasterError('CONFIG_NOT_FOUND', `${path} : fichier de configuration illisible (${code})`);
  }
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch (error) {
    throw new LockmasterError('CONFIG_INVALID', `${path} : TOML invalide : ${(error as Error).message}`);
  }
}

/** Rend absolus les chemins relatifs du document, par rapport à `baseDir`. */
export function resolveRelativePaths(value: unknown, baseDir: string, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveRelativePaths(item, baseDir));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, resolveRelativePaths(child, baseDir, childKey)]),
    );
  }
  if (typeof value === 'string' && value !== '' && PATH_KEY.test(key) && !isAbsolute(value)) {
    return resolve(baseDir, value);
  }
  return value;
}

/** Formate les erreurs zod en « clé : message », une par ligne. */
export function formatIssues(path: string, error: z.ZodError): LockmasterError {
  const lines = error.issues.map((issue) => `- ${issue.path.join('.') || '(racine)'} : ${issue.message}`);
  return new LockmasterError('CONFIG_INVALID', `${path} : configuration invalide :\n${lines.join('\n')}`);
}

/** Charge la configuration : fichier, puis variables LOCKMASTER__*, puis validation complète. */
export function loadConfig(options: { path: string; env: Env }): Config {
  const doc = applyEnvOverrides(readTomlFile(options.path), options.env, {
    prefix: 'LOCKMASTER__',
    schema: configSchema,
  });
  const result = configSchema.safeParse(resolveRelativePaths(doc, dirname(resolve(options.path))));
  if (!result.success) throw formatIssues(options.path, result.error);
  const config = result.data;
  // La clé maîtresse ne doit jamais être dans le dossier de données ni dans ses sauvegardes (docs/02 §3.3).
  if (isInsideReally(config.server.data_dir, config.security.master_key_file)) {
    throw new LockmasterError(
      'CONFIG_INVALID',
      `${options.path} : security.master_key_file ne doit pas se trouver sous server.data_dir`,
    );
  }
  return config;
}
