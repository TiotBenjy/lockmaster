import { type DestinationStream, type Logger, pino } from 'pino';
import type { Config } from './config/schema.js';

// Journaux JSON structurés sur stdout (journald, journaux du conteneur). Champ `event` stable.
// En-têtes porteurs de secrets masqués (SEC-29) : jamais de jeton, de cookie ni de jeton CSRF.
// Les requêtes sont journalisées sans leur chaîne de requête (jetons, codes OIDC, liens de
// réinitialisation).

export type { Logger };

const SENSITIVE_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-csrf-token'];
const REDACTED_PATHS = SENSITIVE_HEADERS.flatMap((header) => [`headers["${header}"]`, `*.headers["${header}"]`]);

interface RequestLike {
  method?: string;
  url?: string;
  ip?: string;
}

/** Sérialiseur de requête : méthode, chemin sans chaîne de requête, adresse IP. Aucun en-tête. */
export function serializeRequest(request: RequestLike): Record<string, string | undefined> {
  return { method: request.method, path: request.url?.split('?')[0], ip: request.ip };
}

export function createLogger(options: Config['log'], destination?: DestinationStream): Logger {
  return pino(
    {
      level: options.level,
      base: { service: 'lockmaster' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      serializers: { req: serializeRequest, err: pino.stdSerializers.err },
      redact: { paths: REDACTED_PATHS, censor: '[masqué]' },
    },
    destination ?? pino.destination({ fd: 1, sync: false }),
  );
}
