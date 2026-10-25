import { LockmasterError } from '../domain/errors.js';

// Autorisation refusée par défaut (CLAUDE.md, invariant 7) : chaque route déclare `config.perm`
// (+ `repoParam` pour une portée dépôt) ou `config.public: true`. Appelée par le hook `onRoute` :
// une route non déclarée empêche le démarrage du serveur.

export interface RouteDeclaration {
  public?: boolean;
  perm?: string;
  repoParam?: string;
}

interface RouteLike {
  url: string;
  method: string | string[];
  config?: unknown;
}

const PERMISSION = /^[a-z]+:[a-z]+$/;

function reject(route: RouteLike, reason: string): LockmasterError {
  const methods = Array.isArray(route.method) ? route.method.join(',') : route.method;
  return new LockmasterError('ROUTE_WITHOUT_PERMISSION', `route ${methods} ${route.url} : ${reason}`);
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
  if (typeof perm !== 'string' || !PERMISSION.test(perm)) {
    throw reject(route, 'config.perm (« domaine:action ») ou config.public: true obligatoire');
  }
  if (repoParam !== undefined && (typeof repoParam !== 'string' || !route.url.includes(`:${repoParam}`))) {
    throw reject(route, `repoParam « ${String(repoParam)} » absent des paramètres de l'URL`);
  }
}
