import { createConnection } from 'node:net';
import { z } from 'zod';
import { LockmasterError } from '../domain/errors.js';
import {
  encodeFrame,
  FrameReader,
  type GenerateKeyRequest,
  generatedKeySchema,
  logSchema,
  type PublicSigningKey,
  parseResponse,
  publicKeySchema,
  type SignerResponse,
  statusSchema,
} from '../domain/signer-protocol.js';

// Client du socket du signataire : seule voie de l'application vers une signature (ADR-0009).
// Une requête par connexion, échéance TOTALE (pas un délai d'inactivité), réponse validée. Toute
// issue (fermeture sans réponse, réponse trop lente, message invalide) rejette la promesse : jamais
// d'attente sans fin, jamais d'exception non gérée. Chaque résultat est validé par un schéma strict : un
// champ inattendu (une clé privée renvoyée par erreur, par exemple) fait rejeter la réponse. Un refus du
// signataire est rendu avec son code.

export interface SignerClientOptions {
  socketPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type GenerateKeyInput = GenerateKeyRequest extends infer R ? (R extends unknown ? Omit<R, 'op'> : never) : never;
export type GeneratedSigningKey = z.infer<typeof generatedKeySchema>;
export type SignerStatus = z.infer<typeof statusSchema>;
export type SignerLogPage = z.infer<typeof logSchema>;

export interface SignerClient {
  ping(): Promise<boolean>;
  status(): Promise<SignerStatus>;
  listKeys(): Promise<PublicSigningKey[]>;
  generateKey(request: GenerateKeyInput): Promise<GeneratedSigningKey>;
  rotateKey(keyId: string): Promise<GeneratedSigningKey>;
  retireKey(keyId: string): Promise<PublicSigningKey>;
  log(range: { afterSeq: number; limit: number }): Promise<SignerLogPage>;
}

const unavailable = (reason: string) =>
  new LockmasterError('SIGNER_UNAVAILABLE', `signataire indisponible : ${reason}`);

/** Envoie une requête au signataire et rend sa réponse validée. */
export function signerRequest(options: SignerClientOptions, message: unknown): Promise<SignerResponse> {
  let frame: Buffer;
  try {
    frame = encodeFrame(message);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const reader = new FrameReader();
    const socket = createConnection({ path: options.socketPath });
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      outcome();
    };
    const onAbort = () => settle(() => reject(unavailable('requête annulée')));
    const deadline = setTimeout(() => settle(() => reject(unavailable('délai dépassé'))), options.timeoutMs);
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('connect', () => socket.write(frame));
    socket.on('error', (error: NodeJS.ErrnoException) => settle(() => reject(unavailable(error.code ?? 'erreur'))));
    socket.on('close', () => settle(() => reject(unavailable('connexion fermée sans réponse complète'))));
    socket.on('data', (chunk: Buffer) => {
      try {
        const message = reader.push(chunk);
        if (message === undefined) return;
        const response = parseResponse(message);
        settle(() => resolve(response));
      } catch (error) {
        settle(() => reject(error));
      }
    });
  });
}

/** Requête dont le résultat est validé par `schema` ; un refus du signataire lève son code. */
async function call<T extends z.ZodType>(
  options: SignerClientOptions,
  message: unknown,
  schema: T,
): Promise<z.infer<T>> {
  const response = await signerRequest(options, message);
  if (!response.ok) {
    throw new LockmasterError(response.error.code.slice(0, 64), `signataire : ${response.error.message.slice(0, 512)}`);
  }
  const result = schema.safeParse(response.result);
  if (!result.success) throw new LockmasterError('SIGNER_RESPONSE_INVALID', 'résultat du signataire mal formé');
  return result.data;
}

const keysSchema = z.strictObject({ keys: z.array(publicKeySchema) });
const retiredSchema = z.strictObject({ key: publicKeySchema });

export function createSignerClient(options: SignerClientOptions): SignerClient {
  return {
    async ping() {
      const response = await signerRequest(options, { op: 'ping' });
      return response.ok && response.result['pong'] === true;
    },
    status: () => call(options, { op: 'status' }, statusSchema),
    listKeys: async () => (await call(options, { op: 'list-keys' }, keysSchema)).keys,
    generateKey: (request) => call(options, { op: 'generate-key', ...request }, generatedKeySchema),
    rotateKey: (keyId) => call(options, { op: 'rotate-key', keyId }, generatedKeySchema),
    retireKey: async (keyId) => (await call(options, { op: 'retire-key', keyId }, retiredSchema)).key,
    log: (range) => call(options, { op: 'log', ...range }, logSchema),
  };
}
