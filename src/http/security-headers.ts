import type { FastifyReply, FastifyRequest } from 'fastify';

// En-têtes de sécurité de toutes les réponses (docs/02 §3.6). La CSP est celle d'ADR-0004 à
// l'identique (amendée par ADR-0011 : font-src 'self'), sans aucune exception.

export const CSP_DIRECTIVES = {
  defaultSrc: ["'none'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  fontSrc: ["'self'"],
  imgSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
  baseUri: ["'none'"],
};

const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** La CSP sous forme d'en-tête, pour les réponses produites hors des hooks de helmet. */
export const CSP_HEADER = Object.entries(CSP_DIRECTIVES)
  .map(([name, values]) => `${kebab(name)} ${values.join(' ')}`)
  .join(';');

export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';
export const HSTS_HEADER = 'max-age=31536000; includeSubDomains';

/** En-têtes communs ajoutés à chaque réponse (hook onSend). */
export function applyCommonHeaders(request: FastifyRequest, reply: FastifyReply): void {
  reply.header('permissions-policy', PERMISSIONS_POLICY);
  reply.header('x-request-id', request.id);
  if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
}

/**
 * Jeu complet d'en-têtes pour les erreurs que Fastify produit avant les hooks (URL mal encodée,
 * type de contenu illisible) : helmet ne s'y exécute pas.
 */
export function applyBaselineHeaders(request: FastifyRequest, reply: FastifyReply, hsts: boolean): void {
  reply.header('content-security-policy', CSP_HEADER);
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('cross-origin-opener-policy', 'same-origin');
  reply.header('cross-origin-resource-policy', 'same-origin');
  reply.header('x-frame-options', 'DENY');
  if (hsts) reply.header('strict-transport-security', HSTS_HEADER);
  applyCommonHeaders(request, reply);
}
