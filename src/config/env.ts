import type { z } from 'zod';
import { LockmasterError } from '../domain/errors.js';
import { type LeafKind, schemaLeaves } from './introspect.js';

// Surcharge clé par clé par variables d'environnement <PRÉFIXE><SECTION>__<CLE> (casse ignorée).
// Tableaux et tables : JSON. Clé inconnue : erreur (deploy/lockmaster.example.toml, en-tête).

export interface EnvOptions {
  prefix: string;
  schema: z.ZodType;
  /** Clés qui ne se déclarent que dans le fichier (ex. publish.targets). */
  fileOnly?: readonly string[];
}

const DEFAULT_FILE_ONLY = ['publish.targets'];

function convert(name: string, raw: string, kind: LeafKind): unknown {
  const fail = (expected: string) =>
    new LockmasterError('CONFIG_INVALID_ENV', `variable ${name} : ${expected} attendu`);
  if (kind === 'string') return raw;
  if (kind === 'number') {
    if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(raw)) throw fail('un nombre');
    return Number(raw);
  }
  if (kind === 'boolean') {
    if (raw !== 'true' && raw !== 'false') throw fail('true ou false');
    return raw === 'true';
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw fail('du JSON');
  }
}

function setPath(doc: Record<string, unknown>, keys: readonly string[], value: unknown, name: string): void {
  let node = doc;
  for (const key of keys.slice(0, -1)) {
    const child = node[key] ?? {};
    if (typeof child !== 'object' || child === null || Array.isArray(child)) {
      throw new LockmasterError('CONFIG_INVALID_ENV', `variable ${name} : « ${key} » n'est pas une table`);
    }
    node[key] = { ...child };
    node = node[key] as Record<string, unknown>;
  }
  node[keys.at(-1) as string] = value;
}

/** Renvoie une copie du document de configuration avec les surcharges de l'environnement. */
export function applyEnvOverrides(
  doc: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
  options: EnvOptions,
): Record<string, unknown> {
  const leaves = schemaLeaves(options.schema);
  const fileOnly = new Set(options.fileOnly ?? DEFAULT_FILE_ONLY);
  const result: Record<string, unknown> = structuredClone(doc);
  const prefix = options.prefix.toLowerCase();
  for (const [name, raw] of Object.entries(env)) {
    if (raw === undefined || !name.toLowerCase().startsWith(prefix)) continue;
    const keys = name.slice(prefix.length).toLowerCase().split('__');
    const dotted = keys.join('.');
    if (fileOnly.has(dotted)) {
      throw new LockmasterError('CONFIG_ENV_NOT_ALLOWED', `variable ${name} : ${dotted} se déclare dans le fichier`);
    }
    const kind = leaves.get(dotted);
    if (kind === undefined || keys.some((key) => key === '')) {
      throw new LockmasterError('CONFIG_UNKNOWN_ENV', `variable ${name} : clé de configuration inconnue`);
    }
    setPath(result, keys, convert(name, raw, kind), name);
  }
  return result;
}
