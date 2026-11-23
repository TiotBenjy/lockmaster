import { createHash } from 'node:crypto';
import { apkKeyFingerprint, generateApkRsaKey } from '../crypto/apk-rsa.js';
import {
  generateOpenPgpKey,
  OPENPGP_KEY_VALIDITY_DAYS,
  type OpenPgpKeyType,
  openPgpKeyType,
} from '../crypto/openpgp.js';
import { LockmasterError } from '../domain/errors.js';
import type { IdGenerator } from '../domain/id.js';
import type { Clock } from '../domain/ports.js';
import type { GenerateKeyRequest, PublicSigningKey } from '../domain/signer-protocol.js';
import type { KeyEventKind, SignatureJournal } from './journal.js';
import {
  type KeyIdentity,
  type KeyKind,
  type KeyPurpose,
  type KeyRecord,
  type KeyState,
  type KeyStore,
  validateKeyLine,
} from './keystore.js';

// Gestion des clés par le socket (ADR-0009) : générer, faire tourner, retirer, lister, état, journal.
// Le matériel de clé est produit en mémoire ; l'insertion, les changements d'état et l'entrée de journal
// sont faits dans une seule transaction. Le certificat de révocation est rendu une fois et jamais stocké
// (SEC-06). Aucune opération ne rend de clé privée ni ne change l'identité d'une clé existante.

export interface KeyMaterial {
  privateKey: string;
  publicKey: string;
  fingerprint: string;
  revocationCertificate?: string;
  expiresAt: number | null;
}

export interface KeyGenerators {
  openpgp(request: { name: string; type: OpenPgpKeyType; date: Date }): Promise<KeyMaterial>;
  apk(): Promise<KeyMaterial>;
}

export interface SignerOperationsDeps {
  keys: KeyStore;
  journal: SignatureJournal;
  clock: Clock;
  newId: IdGenerator;
  /** Transaction synchrone sur la base du signataire. */
  atomic: <T>(fn: () => T) => T;
  generators: KeyGenerators;
}

export interface GeneratedKey {
  key: PublicSigningKey;
  revocationCertificate?: string;
}

const DAY_MS = 86_400_000;

/** Générateurs de production : OpenPGP v4 (2 ans de validité, docs/03 §5) et RSA 4096 pour APK. */
export const productionGenerators: KeyGenerators = {
  async openpgp({ name, type, date }) {
    const key = await generateOpenPgpKey({ name, type, date, validityDays: OPENPGP_KEY_VALIDITY_DAYS });
    return { ...key, expiresAt: date.getTime() + OPENPGP_KEY_VALIDITY_DAYS * DAY_MS };
  },
  async apk() {
    const { privateKeyPem, publicKeyPem } = await generateApkRsaKey();
    return {
      privateKey: privateKeyPem,
      publicKey: publicKeyPem,
      fingerprint: apkKeyFingerprint(publicKeyPem),
      expiresAt: null,
    };
  },
};

const MAX_LIVE_KEYS = 512;

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Échéance de la demande passée (ou client parti) : rien n'est écrit, le refus est journalisé par l'appelant. */
function ensureNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new LockmasterError('SIGNER_TIMEOUT', 'délai de requête dépassé');
}
const invalidRequest = (reason: string) => new LockmasterError('SIGNER_REQUEST_INVALID', reason);

function toPublic(record: KeyRecord): PublicSigningKey {
  return {
    ...record,
    identity: record.identity === null ? null : { ...record.identity, allowedNames: [...record.identity.allowedNames] },
  };
}

/** Clés de la même lignée : même usage, même type, même dépôt (aucun pour la clé d'audit). */
const sameLine = (a: KeyRecord, b: { purpose: KeyPurpose; kind: KeyKind; identity: KeyIdentity | null }) =>
  a.purpose === b.purpose && a.kind === b.kind && a.identity?.repoName === b.identity?.repoName;

export class SignerOperations {
  readonly #deps: SignerOperationsDeps;

  constructor(deps: SignerOperationsDeps) {
    this.#deps = deps;
  }

  status() {
    const keys: Record<KeyState, number> = { active: 0, rotating_in: 0, rotating_out: 0, retired: 0 };
    for (const key of this.#deps.keys.list()) keys[key.state] += 1;
    return { keys, journalHead: this.#deps.journal.head() };
  }

  /** Le socket ne rend que les clés non retirées (réponse bornée) ; la CLI locale voit aussi les retirées. */
  listKeys(options: { includeRetired: boolean } = { includeRetired: true }) {
    const keys = this.#deps.keys.list().filter((key) => options.includeRetired || key.state !== 'retired');
    return { keys: keys.map(toPublic) };
  }

  log(range: { afterSeq: number; limit: number }) {
    return { entries: this.#deps.journal.list(range), head: this.#deps.journal.head() };
  }

  async generateKey(request: GenerateKeyRequest, signal?: AbortSignal): Promise<GeneratedKey> {
    const line =
      request.purpose === 'audit'
        ? { purpose: 'audit' as const, kind: 'openpgp' as const, identity: null }
        : { purpose: 'repo' as const, kind: request.kind, identity: request.identity };
    let type: OpenPgpKeyType = 'rsa4096';
    if (request.purpose === 'repo' && request.algorithm !== undefined) {
      if (request.kind !== 'openpgp') throw invalidRequest('algorithme réservé aux clés OpenPGP');
      if (request.algorithm === 'ed25519' && request.identity.repoFormat !== 'deb') {
        throw invalidRequest('Ed25519 réservé aux dépôts APT (docs/02 §3.3)');
      }
      type = request.algorithm;
    }
    // Contrôles avant la génération coûteuse, refaits dans la transaction.
    validateKeyLine(line.purpose, line.kind, line.identity);
    this.#ensureRoomFor(line);
    const material = await this.#material(line, type);
    return this.#deps.atomic(() => {
      ensureNotAborted(signal);
      this.#ensureRoomFor(line);
      const key = this.#insert(line, material, 'active');
      const repo = line.identity === null ? {} : { repo: line.identity.repoName };
      this.#journal('key-generate', key, { purpose: line.purpose, kind: line.kind, ...repo });
      return this.#generated(key, material);
    });
  }

  async rotateKey(keyId: string, signal?: AbortSignal): Promise<GeneratedKey> {
    const old = this.#active(keyId);
    // L'ancienne clé doit se déchiffrer : une identité modifiée en base (AAD) ne passe pas à la nouvelle.
    this.#deps.keys.privateKey(old.id);
    this.#ensureBelowLimit();
    const type = old.kind === 'openpgp' ? await openPgpKeyType(old.publicKey) : 'rsa4096';
    const material = await this.#material(old, type);
    return this.#deps.atomic(() => {
      ensureNotAborted(signal);
      this.#ensureBelowLimit();
      this.#deps.keys.transition(old.id, ['active'], 'rotating_out');
      const key = this.#insert(old, material, 'rotating_in');
      this.#journal('key-rotate', key, { previousKeyId: old.id });
      return this.#generated(key, material);
    });
  }

  /** Retire une clé ; si elle était en rotation, l'autre clé de la lignée redevient active. */
  retireKey(keyId: string): { key: PublicSigningKey } {
    return this.#deps.atomic(() => {
      const key = this.#deps.keys.get(keyId);
      if (!key) throw new LockmasterError('KEY_NOT_FOUND', 'clé inconnue');
      const partnerState =
        key.state === 'rotating_out' ? 'rotating_in' : key.state === 'rotating_in' ? 'rotating_out' : null;
      const partner = this.#deps.keys.list().find((other) => other.state === partnerState && sameLine(other, key));
      // La clé réactivée doit être intacte (identité liée à l'AAD).
      if (partner) this.#deps.keys.privateKey(partner.id);
      this.#deps.keys.transition(key.id, ['active', 'rotating_in', 'rotating_out'], 'retired');
      if (partner) this.#deps.keys.transition(partner.id, [partner.state], 'active');
      this.#journal('key-retire', key, partner ? { promotedKeyId: partner.id } : {});
      return { key: toPublic({ ...key, state: 'retired' }) };
    });
  }

  /** Une seule clé non retirée par lignée. */
  #ensureRoomFor(line: { purpose: KeyPurpose; kind: KeyKind; identity: KeyIdentity | null }): void {
    if (this.#deps.keys.list().some((key) => key.state !== 'retired' && sameLine(key, line))) {
      throw new LockmasterError('KEY_EXISTS', 'une clé existe déjà pour ce dépôt et ce type : faire une rotation');
    }
    this.#ensureBelowLimit();
  }

  /** Nombre de clés non retirées borné : la réponse de list-keys reste petite. */
  #ensureBelowLimit(): void {
    const live = this.#deps.keys.list().filter((key) => key.state !== 'retired').length;
    if (live >= MAX_LIVE_KEYS)
      throw new LockmasterError('SIGNER_KEY_LIMIT', `au plus ${MAX_LIVE_KEYS} clés non retirées`);
  }

  #active(keyId: string): KeyRecord {
    const key = this.#deps.keys.get(keyId);
    if (!key) throw new LockmasterError('KEY_NOT_FOUND', 'clé inconnue');
    if (key.state !== 'active') throw new LockmasterError('KEY_STATE_CONFLICT', 'seule une clé active peut tourner');
    return key;
  }

  #material(line: { purpose: KeyPurpose; kind: KeyKind; identity: KeyIdentity | null }, type: OpenPgpKeyType) {
    if (line.kind === 'apk-rsa') return this.#deps.generators.apk();
    const name = line.identity === null ? 'Lockmaster audit' : `Lockmaster ${line.identity.repoName}`;
    return this.#deps.generators.openpgp({ name, type, date: this.#deps.clock.now() });
  }

  #insert(
    line: { purpose: KeyPurpose; kind: KeyKind; identity: KeyIdentity | null },
    material: KeyMaterial,
    state: KeyState,
  ): KeyRecord {
    const record: KeyRecord = {
      id: this.#deps.newId(),
      kind: line.kind,
      purpose: line.purpose,
      fingerprint: material.fingerprint,
      publicKey: material.publicKey,
      identity: line.identity,
      state,
      createdAt: this.#deps.clock.now().getTime(),
      expiresAt: material.expiresAt,
    };
    this.#deps.keys.insert({ ...record, privateKey: material.privateKey });
    return record;
  }

  #journal(kind: KeyEventKind, key: KeyRecord, request: Record<string, unknown>): void {
    this.#deps.journal.append({
      at: this.#deps.clock.now().getTime(),
      keyId: key.id,
      kind,
      contentSha256: sha256(key.publicKey),
      request,
      outcome: 'done',
    });
  }

  #generated(key: KeyRecord, material: KeyMaterial): GeneratedKey {
    const certificate = material.revocationCertificate;
    return certificate === undefined
      ? { key: toPublic(key) }
      : { key: toPublic(key), revocationCertificate: certificate };
  }
}
