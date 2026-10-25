import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Format d'erreur unique (docs/06 §1) : { error: { code, message, requestId } }. Jamais de pile, de
// chemin ni de SQL. Une erreur inattendue (5xx, ou code hors de 400..599) est journalisée avec son
// détail et renvoyée générique.

const CLIENT_ERRORS: Record<number, [code: string, message: string]> = {
  400: ['VALIDATION', 'requête invalide'],
  401: ['UNAUTHENTICATED', 'authentification requise'],
  403: ['FORBIDDEN', 'accès refusé'],
  404: ['NOT_FOUND', 'ressource introuvable'],
  405: ['METHOD_NOT_ALLOWED', 'méthode non autorisée'],
  406: ['NOT_ACCEPTABLE', 'format de réponse non disponible'],
  408: ['REQUEST_TIMEOUT', 'délai de requête dépassé'],
  413: ['PAYLOAD_TOO_LARGE', 'corps de requête trop gros'],
  415: ['UNSUPPORTED_MEDIA_TYPE', 'type de contenu non pris en charge'],
  429: ['RATE_LIMITED', 'trop de requêtes'],
};

/** Envoie une erreur au format commun ; le message est toujours l'un des messages génériques ci-dessus. */
export function sendError(reply: FastifyReply, request: FastifyRequest, status: number) {
  const [code, message] =
    CLIENT_ERRORS[status] ?? (status < 500 ? ['BAD_REQUEST', 'requête refusée'] : ['INTERNAL', 'erreur interne']);
  return reply
    .code(status)
    .type('application/json')
    .send({ error: { code, message, requestId: request.id } });
}

export function registerErrorHandlers(app: FastifyInstance): void {
  // Seul gestionnaire 404 du serveur (un autre échapperait au contrôle d'accès : check-forbidden.mjs).
  app.setNotFoundHandler((request, reply) => sendError(reply, request, 404));

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      request.log.info({ event: 'http.client_error', status, code: error.code }, 'request rejected');
      return sendError(reply, request, status);
    }
    request.log.error({ event: 'http.error', status, err: error }, 'internal error');
    return sendError(reply, request, 500);
  });
}
