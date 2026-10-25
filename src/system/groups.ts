import { readFileSync } from 'node:fs';
import { LockmasterError } from '../domain/errors.js';

// Résolution d'un groupe système (nom de /etc/group, ou numéro) sans outil externe.

/** Numéro du groupe `spec` : entier décimal tel quel, sinon nom cherché dans `groupFile`. */
export function resolveGroup(spec: string, groupFile = '/etc/group'): number {
  if (/^(0|[1-9]\d{0,9})$/.test(spec)) return Number(spec);
  for (const line of readFileSync(groupFile, 'utf8').split('\n')) {
    const [name, , gid] = line.split(':');
    if (name === spec && gid !== undefined && /^\d+$/.test(gid)) return Number(gid);
  }
  throw new LockmasterError('ACCOUNT_MISSING', `groupe système « ${spec} » absent (${groupFile})`);
}
