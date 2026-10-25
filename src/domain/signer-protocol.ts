import { z } from 'zod';
import { LockmasterError } from './errors.js';

// Protocole du socket du signataire (ADR-0009), partagé par src/signer/ et src/signer-client/ :
// une requête par connexion, message JSON précédé de sa longueur (4 octets big-endian), 16 Mio au
// plus, validé par zod des deux côtés. Opérations prévues : ping, status, list-keys, generate-key,
// rotate-key, retire-key, sign, log ; seule `ping` existe au jalon M0. Aucune n'exporte de clé.

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const HEADER_BYTES = 4;

const OPERATIONS = ['ping', 'status', 'list-keys', 'generate-key', 'rotate-key', 'retire-key', 'sign', 'log'];
const IMPLEMENTED = new Set(['ping']);

const pingRequest = z.strictObject({ op: z.literal('ping') });
export type SignerRequest = z.infer<typeof pingRequest>;

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
  #chunks: Buffer[] = [];
  #size = 0;
  #expected: number | undefined;
  #done = false;

  push(chunk: Buffer): unknown | undefined {
    if (this.#done) throw fail('SIGNER_FRAME_INVALID', 'une seule requête par connexion');
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    if (this.#expected === undefined && this.#size >= HEADER_BYTES) {
      this.#expected = Buffer.concat(this.#chunks).readUInt32BE(0);
      if (this.#expected > MAX_FRAME_BYTES) throw fail('SIGNER_FRAME_TOO_LARGE', 'message de plus de 16 Mio');
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
  const result = pingRequest.safeParse(message);
  if (!result.success) throw fail('SIGNER_REQUEST_INVALID', 'requête mal formée');
  return result.data;
}

export function parseResponse(message: unknown): SignerResponse {
  const result = responseSchema.safeParse(message);
  if (!result.success) throw fail('SIGNER_RESPONSE_INVALID', 'réponse du signataire mal formée');
  return result.data;
}
