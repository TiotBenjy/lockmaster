import { LockmasterError } from './errors.js';

// JSON canonique pour les journaux chaînés (journal de signatures, audit) : clés triées à tous les
// niveaux, valeurs JSON seulement (chaînes, nombres finis, booléens, null, tableaux, objets simples), donc
// un même contenu donne toujours les mêmes octets. La profondeur est vérifiée avant de descendre : la
// récursion ne dépasse jamais `maxDepth` niveaux, même pour une entrée imbriquée sur des milliers de niveaux.

const invalid = (reason: string) => new LockmasterError('CANONICAL_JSON_INVALID', reason);

export function canonicalJson(value: unknown, maxDepth: number, depth = 0): string {
  if (depth > maxDepth) throw invalid('profondeur maximale dépassée');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid('nombre non fini');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, maxDepth, depth + 1)).join(',')}]`;
  if (typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const members = entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, maxDepth, depth + 1)}`);
    return `{${members.join(',')}}`;
  }
  throw invalid('valeur non JSON');
}
