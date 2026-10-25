import { createConnection } from 'node:net';
import { LockmasterError } from '../domain/errors.js';
import { encodeFrame, FrameReader, parseResponse, type SignerResponse } from '../domain/signer-protocol.js';

// Client du socket du signataire : seule voie de l'application vers une signature (ADR-0009).
// Une requête par connexion, échéance TOTALE (pas un délai d'inactivité), réponse validée. Toute
// issue (fermeture sans réponse, réponse trop lente, message invalide) rejette la promesse : jamais
// d'attente sans fin, jamais d'exception non gérée. Au jalon M0 : `ping`.

export interface SignerClientOptions {
  socketPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SignerClient {
  ping(): Promise<boolean>;
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

export function createSignerClient(options: SignerClientOptions): SignerClient {
  return {
    async ping() {
      const response = await signerRequest(options, { op: 'ping' });
      return response.ok && response.result['pong'] === true;
    },
  };
}
