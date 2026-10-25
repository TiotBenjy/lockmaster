import type { FastifyInstance } from 'fastify';
import { sendError } from './errors.js';

// Autorisation appliquée à CHAQUE requête (invariant 7) : seule une route déclarée
// `config.public: true` répond sans identifiants. Tant que src/auth/ n'existe pas (M6), toute autre
// route est refusée (401) : refus par défaut. En M6, ce hook délègue à `can(principal, perm, repo)`.
// Les requêtes sans route (404) passent : elles aboutissent au seul gestionnaire 404 du serveur.

export function registerAuthorization(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.is404 || request.routeOptions.config.public === true) return;
    return sendError(reply, request, 401);
  });
}
