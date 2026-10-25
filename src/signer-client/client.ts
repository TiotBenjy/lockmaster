import { createConnection } from 'node:net';
import { LockmasterError } from '../domain/errors.js';
import { encodeFrame, FrameReader, parseResponse, type SignerResponse } from '../domain/signer-protocol.js';

// Client du socket du signataire : seule voie de l'application vers une signature (ADR-0009).
// Une requête par connexion, délai borné, réponse validée. Au jalon M0 : `ping`.

export interface SignerClientOptions {
  socketPath: string;
  timeoutMs: number;
}

export interface SignerClient {
  ping(): Promise<boolean>;
}

function request(options: SignerClientOptions, message: unknown): Promise<SignerResponse> {
  return new Promise((resolve, reject) => {
    const reader = new FrameReader();
    const socket = createConnection(options.socketPath);
    const fail = (code: string, text: string) => {
      socket.destroy();
      reject(new LockmasterError(code, text));
    };
    socket.setTimeout(options.timeoutMs, () => fail('SIGNER_UNAVAILABLE', 'le signataire ne répond pas'));
    socket.on('connect', () => socket.write(encodeFrame(message)));
    socket.on('error', (error: NodeJS.ErrnoException) =>
      fail('SIGNER_UNAVAILABLE', `signataire injoignable (${error.code ?? 'erreur'})`),
    );
    socket.on('data', (chunk: Buffer) => {
      try {
        const response = reader.push(chunk);
        if (response === undefined) return;
        socket.end();
        resolve(parseResponse(response));
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
  });
}

export function createSignerClient(options: SignerClientOptions): SignerClient {
  return {
    async ping() {
      const response = await request(options, { op: 'ping' });
      return response.ok && response.result['pong'] === true;
    },
  };
}
