import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Format d'erreur unique (docs/06 §1) : { error: { code, message, requestId } }. Jamais de pile, de
// chemin ni de SQL. Une erreur inattendue (5xx) est journalisée avec son détail et renvoyée générique.

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

function send(reply: FastifyReply, request: FastifyRequest, status: number, code: string, message: string) {
  return reply
    .code(status)
    .type('application/json')
    .send({ error: { code, message, requestId: request.id } });
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => send(reply, request, 404, 'NOT_FOUND', 'ressource introuvable'));

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    const known = CLIENT_ERRORS[status];
    if (status < 500 && known) {
      request.log.info({ event: 'http.client_error', status, code: error.code }, 'requête refusée');
      return send(reply, request, status, known[0], known[1]);
    }
    if (status < 500) return send(reply, request, status, 'BAD_REQUEST', 'requête refusée');
    request.log.error({ event: 'http.error', err: error }, 'erreur interne');
    return send(reply, request, 500, 'INTERNAL', 'erreur interne');
  });
}
