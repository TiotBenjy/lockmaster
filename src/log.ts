import { type DestinationStream, type Logger, pino } from 'pino';
import type { Config } from './config/schema.js';

// Journaux JSON structurés sur stdout (journald, journaux du conteneur). Champ `event` stable.
// En-têtes porteurs de secrets masqués (SEC-29) : jamais de jeton, de cookie ni de jeton CSRF.

export type { Logger };

const SENSITIVE_HEADERS = ['authorization', 'cookie', 'set-cookie', '"x-csrf-token"'];
const REDACTED_PATHS = SENSITIVE_HEADERS.flatMap((header) => [
  `req.headers.${header}`,
  `res.headers.${header}`,
  `headers.${header}`,
]).map((path) => path.replace('."x-csrf-token"', '["x-csrf-token"]').replace('.set-cookie', '["set-cookie"]'));

export function createLogger(options: Config['log'], destination?: DestinationStream): Logger {
  return pino(
    {
      level: options.level,
      base: { service: 'lockmaster' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACTED_PATHS, censor: '[masqué]' },
    },
    destination ?? pino.destination({ fd: 1, sync: false }),
  );
}
