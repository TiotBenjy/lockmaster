import { z } from 'zod';
import { LockmasterError } from './errors.js';

// Protocole du socket du signataire (ADR-0009), partagé par src/signer/ et src/signer-client/ :
// une requête par connexion, message JSON précédé de sa longueur (4 octets big-endian), 16 Mio au
// plus, validé par zod des deux côtés (schémas stricts : tout champ inconnu est refusé). Opérations :
// ping, status, list-keys, generate-key, rotate-key, retire-key, log ; sign arrive avec ses contrôles par
// type de demande. Aucune n'exporte de clé privée ni ne modifie l'identité d'une clé.

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const HEADER_BYTES = 4;

const OPERATIONS = ['ping', 'status', 'list-keys', 'generate-key', 'rotate-key', 'retire-key', 'sign', 'log'];
const IMPLEMENTED = new Set(['ping', 'status', 'list-keys', 'generate-key', 'rotate-key', 'retire-key', 'log']);

const keyId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/);
const identitySchema = z.strictObject({
  repoName: z.string().max(63),
  repoFormat: z.enum(['deb', 'rpm', 'apk']),
  originLabel: z.string().max(128),
  allowedNames: z.array(z.string().max(128)).max(256),
});

const requestSchema = z.union([
  z.strictObject({ op: z.literal('ping') }),
  z.strictObject({ op: z.literal('status') }),
  z.strictObject({ op: z.literal('list-keys') }),
  z.strictObject({
    op: z.literal('generate-key'),
    purpose: z.literal('repo'),
    kind: z.enum(['openpgp', 'apk-rsa']),
    algorithm: z.enum(['rsa4096', 'ed25519']).optional(),
    identity: identitySchema,
  }),
  z.strictObject({ op: z.literal('generate-key'), purpose: z.literal('audit') }),
  z.strictObject({ op: z.literal('rotate-key'), keyId }),
  z.strictObject({ op: z.literal('retire-key'), keyId }),
  z.strictObject({ op: z.literal('log'), afterSeq: z.number().int().min(0), limit: z.number().int().min(1).max(1000) }),
]);
export type SignerRequest = z.infer<typeof requestSchema>;
export type GenerateKeyRequest = Extract<SignerRequest, { op: 'generate-key' }>;

// Résultats, validés par le client (src/signer-client/).
export const publicKeySchema = z.strictObject({
  id: keyId,
  kind: z.enum(['openpgp', 'apk-rsa']),
  purpose: z.enum(['repo', 'audit']),
  fingerprint: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
  publicKey: z.string().max(64 * 1024),
  identity: identitySchema.nullable(),
  state: z.enum(['active', 'rotating_in', 'rotating_out', 'retired']),
  createdAt: z.number().int(),
  expiresAt: z.number().int().nullable(),
});
export type PublicSigningKey = z.infer<typeof publicKeySchema>;

export const generatedKeySchema = z.strictObject({
  key: publicKeySchema,
  /** Certificat de révocation OpenPGP, rendu une seule fois et jamais stocké par le signataire (SEC-06). */
  revocationCertificate: z
    .string()
    .max(64 * 1024)
    .optional(),
});

const journalHeadSchema = z
  .strictObject({ seq: z.number().int().min(1), hash: z.string().regex(/^[0-9a-f]{64}$/) })
  .nullable();

export const statusSchema = z.strictObject({
  keys: z.strictObject({
    active: z.number().int().min(0),
    rotating_in: z.number().int().min(0),
    rotating_out: z.number().int().min(0),
    retired: z.number().int().min(0),
  }),
  journalHead: journalHeadSchema,
});

export const logSchema = z.strictObject({
  entries: z.array(
    z.strictObject({
      seq: z.number().int().min(1),
      at: z.number().int(),
      keyId: keyId.nullable(),
      kind: z.string().max(32),
      contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
      request: z.record(z.string(), z.unknown()),
      outcome: z.enum(['signed', 'refused', 'done']),
      reason: z.string().max(512).optional(),
      prevHash: z.string().regex(/^[0-9a-f]{64}$/),
      hash: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
  head: journalHeadSchema,
});

const responseSchema = z.union([
  z.strictObject({ ok: z.literal(true), result: z.record(z.string(), z.unknown()) }),
  z.strictObject({ ok: z.literal(false), error: z.strictObject({ code: z.string(), message: z.string() }) }),
]);
export type SignerResponse = z.infer<typeof responseSchema>;

const fail = (code: string, message: string) => new LockmasterError(code, message);

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_FRAME_BYTES) throw fail('SIGNER_FRAME_TOO_LARGE', 'message de plus de 16 Mio');
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/** Accumule les octets reçus et rend l'unique message de la connexion dès qu'il est complet. */
export class FrameReader {
  readonly #limit: number;
  #chunks: Buffer[] = [];
  #size = 0;
  #expected: number | undefined;
  #done = false;

  /** `limit` : taille maximale du message, jamais au-delà de 16 Mio. */
  constructor(limit = MAX_FRAME_BYTES) {
    this.#limit = Math.min(limit, MAX_FRAME_BYTES);
  }

  push(chunk: Buffer): unknown | undefined {
    if (this.#done) throw fail('SIGNER_FRAME_INVALID', 'une seule requête par connexion');
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    if (this.#expected === undefined && this.#size >= HEADER_BYTES) {
      this.#expected = Buffer.concat(this.#chunks).readUInt32BE(0);
      if (this.#expected > this.#limit) {
        throw fail('SIGNER_FRAME_TOO_LARGE', `message de plus de ${this.#limit} octets`);
      }
    }
    if (this.#expected === undefined || this.#size < HEADER_BYTES + this.#expected) return undefined;
    if (this.#size > HEADER_BYTES + this.#expected) {
      throw fail('SIGNER_FRAME_INVALID', 'octets en trop après le message (une seule requête par connexion)');
    }
    this.#done = true;
    // Une seule copie, quand le message est complet.
    const data = Buffer.concat(this.#chunks);
    try {
      return JSON.parse(data.subarray(HEADER_BYTES).toString('utf8')) as unknown;
    } catch {
      throw fail('SIGNER_FRAME_INVALID', 'message JSON invalide');
    }
  }
}

export function parseRequest(message: unknown): SignerRequest {
  const op = typeof message === 'object' && message !== null ? (message as { op?: unknown }).op : undefined;
  if (typeof op === 'string' && (!OPERATIONS.includes(op) || !IMPLEMENTED.has(op))) {
    throw fail('SIGNER_UNKNOWN_OPERATION', `opération non prise en charge : ${op.slice(0, 32)}`);
  }
  const result = requestSchema.safeParse(message);
  if (!result.success) throw fail('SIGNER_REQUEST_INVALID', 'requête mal formée');
  return result.data;
}

export function parseResponse(message: unknown): SignerResponse {
  const result = responseSchema.safeParse(message);
  if (!result.success) throw fail('SIGNER_RESPONSE_INVALID', 'réponse du signataire mal formée');
  return result.data;
}
