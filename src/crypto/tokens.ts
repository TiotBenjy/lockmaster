import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Jetons (sessions, API, réinitialisation, docs/02 §3.3) : 32 octets de crypto.randomBytes en base64url ;
// seule leur empreinte SHA-256 est stockée, et deux empreintes se comparent en temps constant.

const TOKEN_BYTES = 32;
const API_PREFIX = 'lkm_';
/** Partie affichée d'un jeton d'API (« lkm_ » + 8 caractères) pour le reconnaître sans le révéler. */
const VISIBLE_LENGTH = API_PREFIX.length + 8;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface GeneratedToken {
  /** Valeur à remettre une seule fois à son destinataire ; jamais stockée ni journalisée. */
  token: string;
  /** SHA-256 hexadécimal du jeton, seule forme stockée. */
  hash: string;
}

export interface GeneratedApiToken extends GeneratedToken {
  prefix: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateSecretToken(): GeneratedToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function generateApiToken(): GeneratedApiToken {
  const token = `${API_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, VISIBLE_LENGTH) };
}

/** Égalité de deux empreintes SHA-256 hexadécimales, en temps constant ; faux si l'une est mal formée. */
export function tokenHashesEqual(a: string, b: string): boolean {
  if (!SHA256_HEX.test(a) || !SHA256_HEX.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
