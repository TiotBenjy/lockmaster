import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Deps } from '../app.js';
import { registerErrorHandlers } from './errors.js';
import { assertRouteDeclared, type RouteDeclaration } from './route-guard.js';

// Serveur HTTP de l'application (API, UI d'administration, sondes). Il ne sert aucun fichier de
// dépôt (ADR-0008). En-têtes de sécurité : docs/02 §3.6 ; CSP stricte sans unsafe-* (ADR-0004).

declare module 'fastify' {
  interface FastifyContextConfig extends RouteDeclaration {}
}

export interface ServerOptions {
  /** Vérifications de /readyz (base, boucle d'événements...) : toutes doivent renvoyer true. */
  readinessChecks?: ReadonlyArray<() => boolean>;
  /** Enregistrement de routes supplémentaires (après les plugins de sécurité). */
  register?: (instance: FastifyInstance) => void | Promise<void>;
}

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const MAX_CONNECTIONS = 1024;
const HEADERS_TIMEOUT_MS = 30_000;
const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  baseUri: ["'none'"],
  connectSrc: ["'self'"],
  fontSrc: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
  imgSrc: ["'self'"],
  objectSrc: ["'none'"],
  scriptSrc: ["'self'"],
  scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'"],
  upgradeInsecureRequests: null,
};

export async function buildServer(deps: Deps, options: ServerOptions = {}): Promise<FastifyInstance> {
  const { http } = deps.config;
  const app = Fastify({
    // pino est un FastifyBaseLogger ; le type précis de pino ne doit pas fuir dans FastifyInstance.
    loggerInstance: deps.logger as FastifyBaseLogger,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    requestIdLogLabel: 'requestId',
    trustProxy: http.trusted_proxies.length > 0 ? [...http.trusted_proxies] : false,
    bodyLimit: DEFAULT_BODY_LIMIT,
    requestTimeout: http.request_timeout,
    connectionTimeout: http.request_timeout,
    keepAliveTimeout: 5_000,
    maxRequestsPerSocket: 1_000,
    return503OnClosing: true,
  });
  app.server.maxConnections = MAX_CONNECTIONS;
  app.server.headersTimeout = HEADERS_TIMEOUT_MS;

  // Doit précéder tout enregistrement de route : une route non déclarée bloque le démarrage.
  app.addHook('onRoute', (route) => assertRouteDeclared(route));

  await app.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: http.tls_cert_file !== '' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });
  app.addHook('onSend', async (request, reply) => {
    reply.header('permissions-policy', PERMISSIONS_POLICY);
    reply.header('x-request-id', request.id);
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });
  registerErrorHandlers(app);

  const checks = options.readinessChecks ?? [];
  app.get('/healthz', { config: { public: true } }, async (_request, reply) => reply.type('text/plain').send('ok'));
  app.get('/readyz', { config: { public: true } }, async (request, reply) => {
    const ready = checks.every((check) => {
      try {
        return check();
      } catch (error) {
        request.log.warn({ event: 'http.readiness_check_failed', err: error }, 'vérification /readyz en échec');
        return false;
      }
    });
    return reply
      .code(ready ? 200 : 503)
      .type('text/plain')
      .send(ready ? 'ready' : 'not ready');
  });

  await options.register?.(app);
  await app.ready();
  return app;
}
