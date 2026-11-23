import { createHash } from 'node:crypto';
import type { Clock } from '../domain/ports.js';
import { parseRequest } from '../domain/signer-protocol.js';
import type { Logger } from '../log.js';
import { type JournalKind, SIGNATURE_KINDS, type SignatureJournal } from './journal.js';
import type { KeyStore } from './keystore.js';
import type { SignerOperations } from './operations.js';
import type { SignerSigning } from './signing.js';

// Routage des requêtes du socket vers les opérations, et journalisation de chaque refus d'une demande
// reçue en entier (ADR-0009) : type de la demande quand il est reconnu, `unknown` sinon ; clé citée
// seulement si elle existe (sinon key_id nul) ; empreinte de la demande, jamais son contenu ; horloge
// du signataire.

export interface Dispatcher {
  /** `signal` : échéance de la demande ou départ du client ; une opération longue n'écrit alors rien. */
  handle(message: unknown, signal?: AbortSignal): Promise<Record<string, unknown>>;
  recordRefusal(message: unknown, code: string): void;
}

export interface DispatcherDeps {
  operations: SignerOperations;
  signing: SignerSigning;
  keys: KeyStore;
  journal: SignatureJournal;
  clock: Clock;
  logger: Logger;
}

const REFUSAL_KINDS: Record<string, JournalKind> = {
  'generate-key': 'key-generate',
  'rotate-key': 'key-rotate',
  'retire-key': 'key-retire',
};
const KEY_ID = /^[0-9A-Za-z_-]{1,64}$/;

const field = (message: unknown, name: string): unknown =>
  typeof message === 'object' && message !== null ? (message as Record<string, unknown>)[name] : undefined;

/** Type journalisé d'une demande refusée : celui de la signature demandée, ou de l'opération sur les clés. */
function refusalKind(message: unknown): JournalKind {
  const op = field(message, 'op');
  const kind = field(message, 'kind');
  if (op === 'sign') return SIGNATURE_KINDS.find((known) => known === kind) ?? 'unknown';
  return (typeof op === 'string' && Object.hasOwn(REFUSAL_KINDS, op) ? REFUSAL_KINDS[op] : undefined) ?? 'unknown';
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { operations } = deps;
  return {
    async handle(message, signal) {
      const request = parseRequest(message);
      switch (request.op) {
        case 'ping':
          return { pong: true };
        case 'status':
          return operations.status();
        case 'list-keys':
          return operations.listKeys({ includeRetired: false });
        case 'generate-key':
          return { ...(await operations.generateKey(request, signal)) };
        case 'rotate-key':
          return { ...(await operations.rotateKey(request.keyId, signal)) };
        case 'retire-key':
          return operations.retireKey(request.keyId);
        case 'log':
          return operations.log(request);
        case 'sign':
          return deps.signing.sign(request, signal);
      }
    },

    recordRefusal(message, code) {
      const op = field(message, 'op');
      const keyId = field(message, 'keyId');
      try {
        const known = typeof keyId === 'string' && KEY_ID.test(keyId) && deps.keys.get(keyId) !== undefined;
        deps.journal.append({
          at: deps.clock.now().getTime(),
          keyId: known ? keyId : null,
          kind: refusalKind(message),
          contentSha256: createHash('sha256')
            .update(JSON.stringify(message) ?? '', 'utf8')
            .digest('hex'),
          request: typeof op === 'string' ? { op: op.slice(0, 32) } : {},
          outcome: 'refused',
          reason: code.slice(0, 64),
        });
      } catch {
        deps.logger.error({ event: 'signer.journal_failed', code }, 'refusal not journaled');
      }
    },
  };
}
