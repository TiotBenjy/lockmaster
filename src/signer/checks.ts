import { clearsign, detachSign } from '../crypto/openpgp.js';
import { canonicalJson } from '../domain/canonical-json.js';
import { LockmasterError } from '../domain/errors.js';
import type { SignRequest } from '../domain/signer-protocol.js';
import { type ParsedRelease, parseRelease } from '../formats/deb/release.js';
import type { KeyRecord } from './keystore.js';

// Contrôles par type de demande, avant toute signature (ADR-0009, tableau « Ce que le signataire vérifie
// avant de signer »). Chaque contrôle rend le contenu exact qui sera signé, le contexte à journaliser et
// la fonction de signature ; tout écart lève un code SIGNER_CHECK_* ou SIGNER_KEY_PURPOSE.

export interface PreparedSignature {
  content: Uint8Array;
  request: Record<string, unknown>;
  sign(privateKey: string, now: Date): Promise<Record<string, unknown>>;
}

/** Limites de la configuration du signataire ([limits] de signer.toml). */
export interface CheckLimits {
  maxClockSkewMs: number;
  maxValidUntilDays: number;
}

const DAY_MS = 86_400_000;

const refuse = (code: string, reason: string) => new LockmasterError(code, reason);

function requireKey(key: KeyRecord, purpose: 'repo' | 'audit', kind: KeyRecord['kind'], format?: string): void {
  const matches =
    key.purpose === purpose && key.kind === kind && (format === undefined || key.identity?.repoFormat === format);
  if (!matches) throw refuse('SIGNER_KEY_PURPOSE', 'clé non prévue pour ce type de demande');
}

// Forme canonique : lignes sans blanc final ni retour chariot, aucune ligne vide, un seul saut de ligne
// final. Le texte journalisé, celui de Release.gpg et celui d'InRelease (aux fins de ligne près) coïncident.
const CANONICAL_RELEASE = /^(?:[^\s][^\r\n]*[^\s\r\n]\n|[^\s]\n| [^\r\n]*[^\s\r\n]\n)+$/;

function parsed(content: string): ParsedRelease {
  if (!CANONICAL_RELEASE.test(content)) throw refuse('SIGNER_CHECK_FORMAT', 'Release hors de sa forme canonique');
  try {
    return parseRelease(content);
  } catch {
    throw refuse('SIGNER_CHECK_FORMAT', 'Release mal formé ou contenant des champs inattendus');
  }
}

/** apt-release : Release strict, Origin/Label de l'identité, Date proche, Valid-Until borné, contexte cohérent. */
function aptRelease(
  request: Extract<SignRequest, { kind: 'apt-release' }>,
  key: KeyRecord,
  now: Date,
  limits: CheckLimits,
): PreparedSignature {
  requireKey(key, 'repo', 'openpgp', 'deb');
  const release = parsed(request.content);
  const origin = key.identity?.originLabel ?? '';
  // Label = identité suivie du canal (docs/03 §2.4, SEC-05 : unique par dépôt et par canal).
  const labelOk = release.label === `${origin} ${release.suite}`;
  const signedByOk = release.signedBy === undefined || release.signedBy.toLowerCase() === key.fingerprint;
  const contextOk = request.context.repo === key.identity?.repoName && request.context.channel === release.suite;
  if (release.origin !== origin || !labelOk || !signedByOk || !contextOk) {
    throw refuse('SIGNER_CHECK_IDENTITY', 'Origin, Label, Signed-By ou contexte étranger à la clé');
  }
  if (Math.abs(release.date.getTime() - now.getTime()) > limits.maxClockSkewMs) {
    throw refuse('SIGNER_CHECK_DATE', "Date trop éloignée de l'horloge du signataire");
  }
  const validity = release.validUntil.getTime() - release.date.getTime();
  if (validity <= 0 || validity > limits.maxValidUntilDays * DAY_MS) {
    throw refuse('SIGNER_CHECK_VALIDITY', "Valid-Until hors de l'intervalle ]Date, Date + max_valid_until_days]");
  }
  const content = new TextEncoder().encode(request.content);
  return {
    content,
    request: { ...request.context },
    sign: async (privateKey, at) => ({
      inRelease: await clearsign(privateKey, request.content, at),
      releaseGpg: await detachSign(privateKey, content, at),
    }),
  };
}

/** audit-checkpoint : seulement le JSON canonique de {seq, hash, at}, avec la clé d'audit. */
function auditCheckpoint(
  request: Extract<SignRequest, { kind: 'audit-checkpoint' }>,
  key: KeyRecord,
): PreparedSignature {
  requireKey(key, 'audit', 'openpgp');
  const payload = canonicalJson(request.checkpoint, 1);
  const content = new TextEncoder().encode(payload);
  return {
    content,
    request: { seq: request.checkpoint.seq },
    sign: async (privateKey, at) => ({ payload, signature: await detachSign(privateKey, content, at) }),
  };
}

export function prepareSignature(
  request: SignRequest,
  key: KeyRecord,
  now: Date,
  limits: CheckLimits,
): PreparedSignature {
  switch (request.kind) {
    case 'apt-release':
      return aptRelease(request, key, now, limits);
    case 'audit-checkpoint':
      return auditCheckpoint(request, key);
  }
}
