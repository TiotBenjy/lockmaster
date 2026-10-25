import { randomBytes } from 'node:crypto';
import type { Config } from './config/schema.js';
import type { Clock, RandomSource } from './domain/ports.js';
import { createLogger, type Logger } from './log.js';

// Assemblage des dépendances (CLAUDE.md §SOLID, D) : l'objet Deps est construit ici et passé aux
// services, au serveur HTTP, aux jobs et à la CLI. Aucun singleton global mutable. Les tests
// construisent leur propre Deps avec des faux (test/helpers/deps.ts).

export interface Deps {
  config: Config;
  logger: Logger;
  clock: Clock;
  random: RandomSource;
}

export const systemClock: Clock = { now: () => new Date() };
export const cryptoRandom: RandomSource = { bytes: (length) => new Uint8Array(randomBytes(length)) };

export function createDeps(config: Config): Deps {
  return { config, logger: createLogger(config.log), clock: systemClock, random: cryptoRandom };
}
