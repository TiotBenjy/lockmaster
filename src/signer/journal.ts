import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson } from '../domain/canonical-json.js';
import { LockmasterError } from '../domain/errors.js';
import { runTransaction } from '../system/sqlite-tx.js';

// Journal de signatures du signataire (ADR-0009, docs/05 signature_log) : chaque signature ou refus est
// ajouté avec le hachage de l'entrée précédente ; les triggers interdisent modification et suppression.
// hash = SHA-256(prev_hash || "\n" || JSON du tableau [seq, at, key_id, kind, content_sha256, request,
// outcome, reason]) ; `request` est stocké en JSON canonique (clés triées), donc recalculable tel quel.
// La troncature de la fin de chaîne ne se voit qu'en comparant la tête exportée (SEC-21).

export const SIGNATURE_KINDS = [
  'apt-release',
  'rpm-repomd',
  'rpm-header',
  'apk-index',
  'apk-package',
  'audit-checkpoint',
] as const;
export type SignatureKind = (typeof SIGNATURE_KINDS)[number];
/** Cycle de vie des clés, journalisé comme les signatures (résultat `done`). */
export const KEY_EVENT_KINDS = ['key-generate', 'key-rotate', 'key-retire'] as const;
export type KeyEventKind = (typeof KEY_EVENT_KINDS)[number];
/** `unknown` : refus d'une demande dont le type n'est pas reconnu. */
export type JournalKind = SignatureKind | KeyEventKind | 'unknown';

export interface JournalEntry {
  /** Horloge du signataire, jamais une valeur reçue par le socket. */
  at: number;
  /** Absente seulement pour un refus qui ne désigne aucune clé connue. */
  keyId: string | null;
  kind: JournalKind;
  /** Contenu signé, clé publique (cycle de vie) ou demande refusée. */
  contentSha256: string;
  /** Contexte déclaré par l'application : dépôt, canal, génération, paquet (jamais de contenu signé). */
  request: Record<string, unknown>;
  outcome: 'signed' | 'refused' | 'done';
  reason?: string;
}

export interface JournalRecord extends JournalEntry {
  seq: number;
  prevHash: string;
  hash: string;
}

export type JournalCheck =
  | { ok: true; count: number; head: { seq: number; hash: string } | null }
  | { ok: false; brokenAt: number };

interface Row {
  seq: number;
  at: number;
  key_id: string | null;
  kind: string;
  content_sha256: string;
  request: string;
  outcome: JournalEntry['outcome'];
  reason: string | null;
  prev_hash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[0-9A-Za-z_-]{1,64}$/;
const MAX_PAGE = 1000;
const MAX_REQUEST_BYTES = 4096;
const MAX_REQUEST_DEPTH = 8;
const MAX_REASON_LENGTH = 512;

const invalid = (reason: string) => new LockmasterError('SIGNER_LOG_INVALID', `entrée de journal refusée : ${reason}`);

/** Demande en JSON canonique (domain/canonical-json.ts), refusée avec le code du journal. */
function canonical(value: unknown): string {
  try {
    return canonicalJson(value, MAX_REQUEST_DEPTH);
  } catch (error) {
    throw invalid(`demande : ${(error as Error).message}`);
  }
}

const KIND_RULES: Record<JournalEntry['outcome'], readonly string[]> = {
  signed: SIGNATURE_KINDS,
  done: KEY_EVENT_KINDS,
  refused: [...SIGNATURE_KINDS, ...KEY_EVENT_KINDS, 'unknown'],
};

/** Valide une entrée (défense en profondeur, quel que soit le schéma du socket) ; rend la demande canonique. */
function checkedRequest(entry: JournalEntry): string {
  if (!Number.isSafeInteger(entry.at)) throw invalid('horodatage invalide');
  if (!SHA256.test(entry.contentSha256)) throw invalid('sha256 du contenu mal formé');
  if (!Object.hasOwn(KIND_RULES, entry.outcome) || !KIND_RULES[entry.outcome].includes(entry.kind)) {
    throw invalid('type incompatible avec le résultat');
  }
  if (entry.keyId === null ? entry.outcome !== 'refused' : !KEY_ID.test(entry.keyId)) throw invalid('clé invalide');
  if (entry.reason !== undefined && entry.reason.length > MAX_REASON_LENGTH) throw invalid('motif trop long');
  const request = canonical(entry.request);
  if (Buffer.byteLength(request, 'utf8') > MAX_REQUEST_BYTES) throw invalid('demande de plus de 4 Kio');
  return request;
}

function chainHash(row: Omit<Row, 'hash'>): string {
  const fields = [row.seq, row.at, row.key_id, row.kind, row.content_sha256, row.request, row.outcome, row.reason];
  return createHash('sha256')
    .update(`${row.prev_hash}\n${JSON.stringify(fields)}`, 'utf8')
    .digest('hex');
}

const toRecord = (row: Row): JournalRecord => ({
  seq: row.seq,
  at: row.at,
  keyId: row.key_id,
  kind: row.kind as JournalKind,
  contentSha256: row.content_sha256,
  request: JSON.parse(row.request) as Record<string, unknown>,
  outcome: row.outcome,
  ...(row.reason === null ? {} : { reason: row.reason }),
  prevHash: row.prev_hash,
  hash: row.hash,
});

export class SignatureJournal {
  readonly #db: Database.Database;
  readonly #onAppend: ((record: JournalRecord) => void) | undefined;

  /**
   * `onAppend` : appelé après chaque ajout (journald, export hors hôte de la tête, SEC-21). Dans une
   * transaction englobante, l'ajout au journal est la dernière écriture, donc conservé dès qu'il réussit.
   */
  constructor(db: Database.Database, onAppend?: (record: JournalRecord) => void) {
    this.#db = db;
    this.#onAppend = onAppend;
  }

  append(entry: JournalEntry): JournalRecord {
    const request = checkedRequest(entry);
    const record = runTransaction(this.#db, () => {
      const last = this.#db.prepare('SELECT seq, hash FROM signature_log ORDER BY seq DESC LIMIT 1').get() as
        | { seq: number; hash: string }
        | undefined;
      const row: Omit<Row, 'hash'> = {
        seq: (last?.seq ?? 0) + 1,
        at: entry.at,
        key_id: entry.keyId,
        kind: entry.kind,
        content_sha256: entry.contentSha256,
        request,
        outcome: entry.outcome,
        reason: entry.reason ?? null,
        prev_hash: last?.hash ?? GENESIS,
      };
      const full: Row = { ...row, hash: chainHash(row) };
      this.#db
        .prepare(
          `INSERT INTO signature_log (seq, at, key_id, kind, content_sha256, request, outcome, reason, prev_hash, hash)
           VALUES (@seq, @at, @key_id, @kind, @content_sha256, @request, @outcome, @reason, @prev_hash, @hash)`,
        )
        .run(full);
      return toRecord(full);
    });
    this.#onAppend?.(record);
    return record;
  }

  list(range: { afterSeq: number; limit: number }): JournalRecord[] {
    const { afterSeq, limit } = range;
    if (
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_PAGE
    ) {
      throw new LockmasterError('SIGNER_LOG_RANGE', `tranche de journal invalide (1 à ${MAX_PAGE} entrées)`);
    }
    const rows = this.#db
      .prepare('SELECT * FROM signature_log WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(afterSeq, limit) as Row[];
    return rows.map(toRecord);
  }

  /** Dernière entrée (numéro et hachage), sans parcourir la chaîne : à exporter pour détecter une troncature. */
  head(): { seq: number; hash: string } | null {
    const row = this.#db.prepare('SELECT seq, hash FROM signature_log ORDER BY seq DESC LIMIT 1').get() as
      | { seq: number; hash: string }
      | undefined;
    return row ?? null;
  }

  /** Recalcule toute la chaîne : numéros contigus depuis 1, chaînage et hachage de chaque entrée. */
  verify(): JournalCheck {
    let previous = { seq: 0, hash: GENESIS };
    for (const row of this.#db.prepare('SELECT * FROM signature_log ORDER BY seq').iterate() as Iterable<Row>) {
      if (row.seq !== previous.seq + 1 || row.prev_hash !== previous.hash || chainHash(row) !== row.hash) {
        return { ok: false, brokenAt: row.seq };
      }
      previous = { seq: row.seq, hash: row.hash };
    }
    return { ok: true, count: previous.seq, head: previous.seq === 0 ? null : previous };
  }
}
