import { lstatSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LockmasterError } from '../domain/errors.js';

// Résolution des chemins comme le noyau, pour vérifier qu'un fichier (la clé maîtresse) n'est pas
// sous un dossier (data_dir) : docs/02 §3.3. Les segments sont parcourus dans l'ordre : « .. »
// remonte au parent du chemin RÉEL courant, un lien est remplacé par sa cible lue depuis le dossier
// réel qui le contient (y compris un lien pendant : là où le fichier serait créé). Seule l'absence
// d'un segment est tolérée (le reste est alors ajouté tel quel) ; toute autre erreur refuse.

const MAX_LINK_HOPS = 40;

function unresolvable(path: string, reason: string): LockmasterError {
  return new LockmasterError('PATH_UNRESOLVABLE', `chemin ${path} impossible à résoudre (${reason})`);
}

const segmentsOf = (path: string) => path.split('/').filter((segment) => segment !== '' && segment !== '.');

/** Type du segment : lien, autre, ou absent. Toute erreur autre que l'absence refuse. */
function kindOf(path: string, input: string): 'link' | 'other' | 'missing' {
  try {
    return lstatSync(path).isSymbolicLink() ? 'link' : 'other';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'missing';
    throw unresolvable(input, code ?? 'erreur inconnue');
  }
}

/** Chemin réel de `input`, existant ou non (un chemin relatif l'est au dossier courant). */
export function realpathLenient(input: string): string {
  const pending = segmentsOf(isAbsolute(input) ? input : join(process.cwd(), input));
  let current = '/';
  let hops = 0;
  while (pending.length > 0) {
    const segment = pending.shift() as string;
    if (segment === '..') {
      current = dirname(current);
      continue;
    }
    const candidate = join(current, segment);
    const kind = kindOf(candidate, input);
    if (kind === 'missing') return join(candidate, ...pending);
    if (kind === 'link') {
      hops += 1;
      if (hops > MAX_LINK_HOPS) throw unresolvable(input, 'trop de liens symboliques');
      const target = readlinkSync(candidate);
      if (isAbsolute(target)) current = '/';
      pending.unshift(...segmentsOf(target));
      continue;
    }
    current = candidate;
  }
  return current;
}

/** Vrai si `child` désigne `parent` ou un chemin situé dessous (après normalisation lexicale). */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** Comme `isInside`, sur les chemins lexicaux et sur les chemins réels (liens résolus). */
export function isInsideReally(parent: string, child: string): boolean {
  return isInside(parent, child) || isInside(realpathLenient(parent), realpathLenient(child));
}
