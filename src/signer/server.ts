import { existsSync, lstatSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { DestinationStream } from 'pino';
import { defaultAllowedGids, readSecretFile } from '../config/secret-file.js';
import { parseMasterKey } from '../crypto/master-key.js';
import { LockmasterError } from '../domain/errors.js';
import { encodeFrame, FrameReader, parseRequest, type SignerRequest } from '../domain/signer-protocol.js';
import { createLogger, type Logger } from '../log.js';
import type { SignerConfig } from './config.js';
import { listenOnFd, listenOnPath } from './socket.js';
import { isSignerDatabase, openSignerDatabase, signerDatabasePath } from './store.js';

// Service de signature (ADR-0009) : socket Unix uniquement, une requête par connexion, délai borné.
// Chaque refus est journalisé (event signer.request_refused). Au jalon M0, seule `ping` existe.

const RUN_INIT = 'exécuter lockmaster signer init';
// Peu de clients légitimes (l'application) : 8 connexions bornent aussi la mémoire (8 x 16 Mio).
const MAX_CONNECTIONS = 8;
const CLOSE_GRACE_MS = 1_000;

export interface SignerStartOptions {
  /** Descripteur transmis par systemd (activation par socket) ; sinon écoute sur socket.path. */
  fd?: number;
  logDestination?: DestinationStream;
}

export interface RunningSigner {
  logger: Logger;
  stop(): Promise<void>;
}

function notInitialized(reason: string): LockmasterError {
  return new LockmasterError('NOT_INITIALIZED', `${reason} : ${RUN_INIT}`);
}

/**
 * Groupes admis pour une clé lisible par le groupe : root et le groupe principal du signataire, SAUF
 * le groupe du socket (lockmaster-sign), partagé avec l'application. En compose, le groupe principal
 * du signataire est justement ce groupe : la clé doit alors être en 0400.
 */
export function keyGroups(config: SignerConfig): number[] {
  let socketGroup: number | undefined;
  try {
    const dir = lstatSync(dirname(config.socket.path));
    // Même règle que la vérification du socket : groupe du dossier s'il est setgid, sinon egid.
    socketGroup = (dir.mode & 0o2000) !== 0 ? dir.gid : process.getegid?.();
  } catch {
    return [0];
  }
  return defaultAllowedGids().filter((gid) => gid === 0 || gid !== socketGroup);
}

function preflight(config: SignerConfig) {
  const keyFile = config.security.master_key_file;
  if (!existsSync(keyFile)) throw notInitialized(`clé maîtresse du signataire absente (${keyFile})`);
  parseMasterKey(readSecretFile(keyFile, { allowedGids: keyGroups(config) }));
  const path = signerDatabasePath(config.server.data_dir);
  if (!existsSync(path)) throw notInitialized(`base du signataire absente (${path})`);
  const db = openSignerDatabase(path, { create: false });
  if (!isSignerDatabase(db)) {
    db.close();
    throw notInitialized(`base du signataire non initialisée (${path})`);
  }
  return db;
}

function handle(request: SignerRequest): Record<string, unknown> {
  switch (request.op) {
    case 'ping':
      return { pong: true };
  }
}

function serveConnection(socket: Socket, logger: Logger, timeoutMs: number): void {
  const reader = new FrameReader();
  let finished = false;
  const finish = (response: unknown) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    socket.end(encodeFrame(response));
    // Un client qui garde son côté ouvert ne doit pas occuper un emplacement indéfiniment.
    setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref();
  };
  const refuse = (code: string, message: string) => {
    logger.warn({ event: 'signer.request_refused', code }, 'request refused');
    finish({ ok: false, error: { code, message } });
  };
  const timer = setTimeout(() => refuse('SIGNER_TIMEOUT', 'délai de requête dépassé'), timeoutMs);
  socket.on('close', () => clearTimeout(timer));
  socket.on('error', () => socket.destroy());
  socket.on('data', (chunk: Buffer) => {
    if (finished) return;
    try {
      const message = reader.push(chunk);
      if (message === undefined) return;
      const request = parseRequest(message);
      logger.info({ event: 'signer.request', op: request.op }, 'request served');
      finish({ ok: true, result: handle(request) });
    } catch (error) {
      if (error instanceof LockmasterError) refuse(error.code, error.message);
      else refuse('SIGNER_INTERNAL', 'erreur interne du signataire');
    }
  });
}

export async function startSigner(config: SignerConfig, options: SignerStartOptions = {}): Promise<RunningSigner> {
  const db = preflight(config);
  const logger = createLogger(config.log, options.logDestination);
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    serveConnection(socket, logger, config.socket.timeout);
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.on('drop', () => logger.warn({ event: 'signer.connection_dropped' }, 'connection limit reached'));
  try {
    if (options.fd === undefined) await listenOnPath(server, config.socket.path);
    else await listenOnFd(server, options.fd);
  } catch (error) {
    db.close();
    throw error;
  }
  logger.info({ event: 'signer.listening', activation: options.fd !== undefined }, 'signer listening');
  return {
    logger,
    stop: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of connections) socket.destroy();
      await closed;
      db.close();
    },
  };
}
