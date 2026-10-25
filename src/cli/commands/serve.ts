import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { createDeps } from '../../app.js';
import type { Config } from '../../config/schema.js';
import { readSecretFile } from '../../config/secret-file.js';
import { parseMasterKey } from '../../crypto/master-key.js';
import { type Db, databasePath, isInitialized, openDatabase, ping } from '../../db/connection.js';
import { LockmasterError } from '../../domain/errors.js';
import { buildServer } from '../../http/server.js';
import type { Logger } from '../../log.js';
import { EventLoopMonitor } from '../../process/event-loop.js';
import { installProcessHandlers } from '../../process/lifecycle.js';
import { type CommandContext, loadContextConfig } from '../context.js';

// `lockmaster serve` : refuse de démarrer sans clé maîtresse valide ni base initialisée (code 78,
// « exécuter lockmaster init »), puis sert l'API et les sondes jusqu'à SIGTERM.

const RUN_INIT = 'exécuter lockmaster init';
const EVENT_LOOP_THRESHOLD_MS = 1_000;
// Inférieur au délai d'arrêt de Docker (10 s) et de systemd (TimeoutStopSec, 90 s par défaut).
const SHUTDOWN_TIMEOUT_MS = 8_000;

function notInitialized(reason: string): LockmasterError {
  return new LockmasterError('NOT_INITIALIZED', `${reason} : ${RUN_INIT}`);
}

/** Contrôles avant démarrage : clé maîtresse lisible et valide, base lockmaster initialisée. */
export function preflight(config: Config): Db {
  const keyFile = config.security.master_key_file;
  if (!existsSync(keyFile)) throw notInitialized(`clé maîtresse absente (${keyFile})`);
  parseMasterKey(readSecretFile(keyFile));
  const path = databasePath(config.server.data_dir);
  if (!existsSync(path)) throw notInitialized(`base absente (${path})`);
  const db = openDatabase(path, { create: false });
  if (!isInitialized(db)) {
    db.close();
    throw notInitialized(`base non initialisée (${path})`);
  }
  return db;
}

/**
 * Écoute sur le serveur HTTP sous-jacent plutôt que par `app.listen()` : sur 0.0.0.0, Fastify
 * énumère les interfaces réseau (netlink) pour journaliser ses adresses, ce que lockmaster.service
 * interdit (RestrictAddressFamilies) et qui arrêterait le processus. `app.close()` ferme ce serveur.
 */
async function listen(app: FastifyInstance, address: Config['http']['listen']): Promise<void> {
  await app.ready();
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen({ host: address.host, port: address.port }, () => {
      app.server.off('error', reject);
      resolve();
    });
  });
}

export interface RunningServer {
  logger: Logger;
  stop(): Promise<void>;
}

export async function startServer(config: Config): Promise<RunningServer> {
  const db = preflight(config);
  const deps = createDeps(config);
  const monitor = new EventLoopMonitor({ thresholdMs: EVENT_LOOP_THRESHOLD_MS });
  monitor.start();
  try {
    const app = await buildServer(deps, { readinessChecks: [() => monitor.healthy(), () => ping(db)] });
    await listen(app, config.http.listen);
    deps.logger.info({ event: 'server.listening', ...config.http.listen }, 'lockmaster listening');
    return {
      logger: deps.logger,
      stop: async () => {
        const closing = app.close();
        // Hors app.listen(), Fastify ne ferme pas lui-même les connexions keep-alive inactives.
        app.server.closeIdleConnections();
        await closing;
        monitor.stop();
        db.close();
      },
    };
  } catch (error) {
    monitor.stop();
    db.close();
    throw error;
  }
}

export async function serveCommand(ctx: CommandContext): Promise<number> {
  const running = await startServer(loadContextConfig(ctx));
  installProcessHandlers({
    process,
    exit: (code) => process.exit(code),
    logger: running.logger,
    onShutdown: running.stop,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
  });
  // Le processus se termine par les gestionnaires de signaux (crash-only).
  return new Promise<number>(() => {});
}
