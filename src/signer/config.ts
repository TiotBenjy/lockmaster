import { lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { applyEnvOverrides } from '../config/env.js';
import { duration, path } from '../config/fields.js';
import { formatIssues, readTomlFile, resolveRelativePaths } from '../config/load.js';
import { isInsideReally, realpathLenient } from '../config/real-path.js';
import { LockmasterError } from '../domain/errors.js';

// Configuration du signataire (ADR-0009) : fichier propre, /etc/lockmaster-signer/signer.toml,
// surchargeable par LOCKMASTER_SIGNER__SECTION__CLE. Aucune clé de l'application n'y est admise.
// Le fichier par défaut peut manquer (conteneur : variables d'environnement seules) ; un fichier
// désigné explicitement doit exister.

export const DEFAULT_SIGNER_CONFIG_PATH = '/etc/lockmaster-signer/signer.toml';

export const signerConfigSchema = z.strictObject({
  server: z.strictObject({ data_dir: path('/var/lib/lockmaster-signer') }).prefault({}),
  security: z.strictObject({ master_key_file: path('/etc/lockmaster-signer/master.key') }).prefault({}),
  socket: z.strictObject({ path: path('/run/lockmaster-sign/sign.sock'), timeout: duration('30s') }).prefault({}),
  log: z
    .strictObject({
      level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
      format: z.enum(['json', 'pretty']).default('json'),
    })
    .prefault({}),
});

export type SignerConfig = z.output<typeof signerConfigSchema>;
type Env = Readonly<Record<string, string | undefined>>;

export function resolveSignerConfigPath(cliPath: string | undefined, env: Env): { path: string; explicit: boolean } {
  const chosen = cliPath || env['LOCKMASTER_SIGNER_CONFIG'];
  return chosen ? { path: chosen, explicit: true } : { path: DEFAULT_SIGNER_CONFIG_PATH, explicit: false };
}

/** Seule l'absence du fichier PAR DÉFAUT est tolérée ; un fichier illisible n'est jamais ignoré. */
function defaultFileAbsent(path: string, explicit: boolean): boolean {
  if (explicit) return false;
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export interface SignerConfigOptions {
  path: string;
  env: Env;
  explicit?: boolean;
  /** `--socket` : validé par le schéma comme toute autre valeur (chemin absolu, sans « .. »). */
  socketPath?: string;
}

export function loadSignerConfig(options: SignerConfigOptions): SignerConfig {
  const fileMissing = defaultFileAbsent(options.path, options.explicit ?? true);
  const fromFile = fileMissing ? {} : readTomlFile(options.path);
  const doc = applyEnvOverrides(fromFile, options.env, {
    prefix: 'LOCKMASTER_SIGNER__',
    schema: signerConfigSchema,
    fileOnly: [],
  });
  const baseDir = fileMissing ? '/' : realpathLenient(dirname(resolve(options.path)));
  const resolved = resolveRelativePaths(doc, baseDir) as Record<string, unknown>;
  if (options.socketPath !== undefined) {
    const socket = (resolved['socket'] ?? {}) as Record<string, unknown>;
    resolved['socket'] = { ...socket, path: options.socketPath };
  }
  const result = signerConfigSchema.safeParse(resolved);
  if (!result.success) throw formatIssues(options.path, result.error);
  if (isInsideReally(result.data.server.data_dir, result.data.security.master_key_file)) {
    throw new LockmasterError('CONFIG_INVALID', 'security.master_key_file ne doit pas se trouver sous server.data_dir');
  }
  return result.data;
}
