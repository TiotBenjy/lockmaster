import { existsSync } from 'node:fs';
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
    await app.listen({ host: config.http.listen.host, port: config.http.listen.port });
    deps.logger.info({ event: 'server.listening', ...config.http.listen }, 'lockmaster listening');
    return {
      logger: deps.logger,
      stop: async () => {
        await app.close();
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
