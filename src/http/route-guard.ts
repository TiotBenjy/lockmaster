import { isPermission, type Permission } from '../auth/permissions.js';
import { LockmasterError } from '../domain/errors.js';

// Autorisation refusée par défaut (CLAUDE.md, invariant 7) : chaque route déclare `config.perm`
// (+ `repoParam` pour une portée dépôt) ou `config.public: true`. Appelée par le hook `onRoute` :
// une route non déclarée empêche le démarrage du serveur. L'application à chaque requête est faite
// par le hook `onRequest` de src/http/server.ts.

export interface RouteDeclaration {
  public?: boolean;
  perm?: Permission;
  repoParam?: string;
}

interface RouteLike {
  url: string;
  method: string | string[];
  config?: unknown;
}

function reject(route: RouteLike, reason: string): LockmasterError {
  const methods = Array.isArray(route.method) ? route.method.join(',') : route.method;
  return new LockmasterError('ROUTE_WITHOUT_PERMISSION', `route ${methods} ${route.url} : ${reason}`);
}

/** Vrai si `name` est exactement un paramètre de l'URL (`/:name/`, `/:name` final ou `/:name(regex)`). */
function hasParam(url: string, name: string): boolean {
  return url.split('/').some((segment) => segment === `:${name}` || segment.startsWith(`:${name}(`));
}

export function assertRouteDeclared(route: RouteLike): void {
  const config = (route.config ?? {}) as Record<string, unknown>;
  const isPublic = config['public'];
  const perm = config['perm'];
  const repoParam = config['repoParam'];
  if (isPublic !== undefined && isPublic !== true) throw reject(route, 'public doit valoir true ou être absent');
  if (isPublic === true && perm !== undefined) throw reject(route, 'public et perm sont exclusifs');
  if (isPublic === true) {
    if (repoParam !== undefined) throw reject(route, 'repoParam sans permission');
    return;
  }
  if (!isPermission(perm)) {
    throw reject(route, 'config.perm (permission de docs/02 §3.5) ou config.public: true obligatoire');
  }
  if (repoParam !== undefined && (typeof repoParam !== 'string' || !hasParam(route.url, repoParam))) {
    throw reject(route, `repoParam « ${String(repoParam)} » n'est pas un paramètre de l'URL`);
  }
}
