import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import type { DestinationStream } from 'pino';
import { defaultAllowedGids, readSecretFile } from '../config/secret-file.js';
import { parseMasterKey } from '../crypto/master-key.js';
import { LockmasterError } from '../domain/errors.js';
import { createIdGenerator } from '../domain/id.js';
import type { Clock } from '../domain/ports.js';
import { encodeFrame, FrameReader } from '../domain/signer-protocol.js';
import { createLogger, type Logger } from '../log.js';
import { runTransaction } from '../system/sqlite-tx.js';
import { signerSystemClock } from './clock.js';
import type { SignerConfig } from './config.js';
import { createDispatcher, type Dispatcher } from './dispatch.js';
import { SignatureJournal } from './journal.js';
import { SqliteKeyStore } from './keystore-sqlite.js';
import { migrateSignerDatabase } from './migrations.js';
import { type KeyGenerators, productionGenerators, SignerOperations } from './operations.js';
import { expectedSocketGroup, listenOnFd, listenOnPath } from './socket.js';
import { isSignerDatabase, openSignerDatabase, type SignerDb, signerDatabasePath } from './store.js';

// Service de signature (ADR-0009) : socket Unix uniquement, une requête par connexion, délai borné.
// Chaque refus est journalisé dans journald (event signer.request_refused) et, pour une demande reçue en
// entier, dans le journal de signatures (dispatch.ts).

const RUN_INIT = 'exécuter lockmaster signer init';
// Peu de clients légitimes (l'application) : 8 connexions bornent aussi la mémoire (8 x 16 Mio).
const MAX_CONNECTIONS = 8;
const CLOSE_GRACE_MS = 1_000;

export interface SignerStartOptions {
  /** Descripteur transmis par systemd (activation par socket) ; sinon écoute sur server.socket. */
  fd?: number;
  logDestination?: DestinationStream;
  clock?: Clock;
  /** Générateurs de clés (tests : algorithmes rapides) ; production par défaut. */
  generators?: KeyGenerators;
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
  let socketGroup: number;
  try {
    // Même règle que la vérification du socket (src/signer/socket.ts).
    socketGroup = expectedSocketGroup(config.server.socket_group, config.server.socket);
  } catch {
    return [0];
  }
  return defaultAllowedGids().filter((gid) => gid === 0 || gid !== socketGroup);
}

function preflight(config: SignerConfig, clock: Clock): { db: SignerDb; masterKey: Buffer } {
  const keyFile = config.security.master_key_file;
  if (!existsSync(keyFile)) throw notInitialized(`clé maîtresse du signataire absente (${keyFile})`);
  const masterKey = parseMasterKey(readSecretFile(keyFile, { allowedGids: keyGroups(config) }));
  const path = signerDatabasePath(config.server.data_dir);
  if (!existsSync(path)) throw notInitialized(`base du signataire absente (${path})`);
  const db = openSignerDatabase(path, { create: false });
  if (!isSignerDatabase(db)) {
    db.close();
    throw notInitialized(`base du signataire non initialisée (${path})`);
  }
  try {
    migrateSignerDatabase(db, clock.now().getTime());
  } catch (error) {
    db.close();
    throw error;
  }
  return { db, masterKey };
}

function serveConnection(socket: Socket, logger: Logger, limits: SignerConfig['server'], dispatcher: Dispatcher): void {
  const timeoutMs = limits.request_timeout;
  const reader = new FrameReader(limits.max_message_bytes);
  // Échéance ou départ du client : une opération en cours abandonne sans rien écrire (operations.ts).
  const deadline = new AbortController();
  let finished = false;
  let message: unknown;
  const finish = (response: unknown) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    let frame: Buffer;
    try {
      frame = encodeFrame(response);
    } catch {
      frame = encodeFrame({ ok: false, error: { code: 'SIGNER_INTERNAL', message: 'réponse impossible à encoder' } });
    }
    socket.end(frame);
    // Un client qui garde son côté ouvert ne doit pas occuper un emplacement indéfiniment.
    setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref();
  };
  const refuse = (code: string, message: string) => {
    logger.warn({ event: 'signer.request_refused', code }, 'request refused');
    finish({ ok: false, error: { code, message } });
  };
  const fail = (error: unknown) => {
    if (error instanceof LockmasterError) refuse(error.code, error.message);
    else refuse('SIGNER_INTERNAL', 'erreur interne du signataire');
  };
  const timer = setTimeout(() => {
    deadline.abort();
    if (!finished && message !== undefined) dispatcher.recordRefusal(message, 'SIGNER_TIMEOUT');
    refuse('SIGNER_TIMEOUT', 'délai de requête dépassé');
  }, timeoutMs);
  socket.on('close', () => {
    clearTimeout(timer);
    deadline.abort();
  });
  socket.on('error', () => socket.destroy());
  socket.on('data', (chunk: Buffer) => {
    if (finished) return;
    let complete: unknown;
    try {
      complete = reader.push(chunk);
    } catch (error) {
      // Trame invalide, ou octets après la demande (une seule par connexion) : l'opération éventuelle s'arrête.
      deadline.abort();
      return fail(error);
    }
    if (complete === undefined) return;
    message = complete;
    const received = message;
    dispatcher.handle(received, deadline.signal).then(
      (result) => {
        logger.info({ event: 'signer.request', op: (received as { op: string }).op }, 'request served');
        finish({ ok: true, result });
      },
      (error: unknown) => {
        // Après l'échéance, le refus est déjà journalisé et la réponse envoyée.
        if (finished) return;
        dispatcher.recordRefusal(received, error instanceof LockmasterError ? error.code : 'SIGNER_INTERNAL');
        fail(error);
      },
    );
  });
}

export async function startSigner(config: SignerConfig, options: SignerStartOptions = {}): Promise<RunningSigner> {
  const clock = options.clock ?? signerSystemClock;
  const { db, masterKey } = preflight(config, clock);
  const logger = createLogger(config.log, options.logDestination);
  const keys = new SqliteKeyStore(db, masterKey);
  // Chaque entrée du journal part aussi dans journald (ADR-0009) : tête exportable hors de l'hôte (SEC-21).
  const journal = new SignatureJournal(db, (record) =>
    logger.info(
      {
        event: 'signer.journal_appended',
        seq: record.seq,
        hash: record.hash,
        kind: record.kind,
        keyId: record.keyId,
        outcome: record.outcome,
      },
      'journal entry appended',
    ),
  );
  const operations = new SignerOperations({
    keys,
    journal,
    clock,
    newId: createIdGenerator(clock, { bytes: (length) => randomBytes(length) }),
    atomic: (fn) => runTransaction(db, fn),
    generators: options.generators ?? productionGenerators,
  });
  const dispatcher = createDispatcher({ operations, keys, journal, clock, logger });
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    serveConnection(socket, logger, config.server, dispatcher);
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.on('drop', () => logger.warn({ event: 'signer.connection_dropped' }, 'connection limit reached'));
  try {
    if (options.fd === undefined) await listenOnPath(server, config.server.socket, config.server.socket_group);
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
