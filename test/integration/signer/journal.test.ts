import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type JournalEntry, SignatureJournal } from '../../../src/signer/journal.js';
import { migrateSignerDatabase } from '../../../src/signer/migrations.js';

// Journal de signatures du signataire (ADR-0009) : chaîné par hachage, en ajout seul, vérifiable ; il
// trace aussi les refus (même sans clé connue) et le cycle de vie des clés.

let db: Database.Database;
let journal: SignatureJournal;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = ON');
  migrateSignerDatabase(db, 0);
  db.prepare(
    `INSERT INTO key (id, kind, purpose, fingerprint, public_key, private_key_enc, repo_name, state, created_at)
     VALUES ('k1', 'openpgp', 'repo', 'f1', 'pub', x'00', 'debian-12', 'active', 0)`,
  ).run();
  journal = new SignatureJournal(db);
});
afterEach(() => db.close());

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const entry = (overrides: Partial<JournalEntry> = {}): JournalEntry => ({
  at: 1_800_000_000_000,
  keyId: 'k1',
  kind: 'apt-release',
  contentSha256: sha('Release'),
  request: { repo: 'debian-12', channel: 'stable', generation: 42 },
  outcome: 'signed',
  ...overrides,
});

/** Simule un attaquant qui écrit directement dans le fichier : triggers retirés. */
function dropTriggers(): void {
  db.exec(
    'DROP TRIGGER signature_log_no_update; DROP TRIGGER signature_log_no_delete; DROP TRIGGER signature_log_chain;',
  );
}

describe('SignatureJournal', () => {
  it('chaîne les entrées depuis un hachage initial nul, numérotées sans trou', () => {
    const first = journal.append(entry());
    const second = journal.append(entry({ outcome: 'refused', reason: 'Origin inattendu' }));
    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe('0'.repeat(64));
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatchObject({ seq: 2, prevHash: first.hash, outcome: 'refused', reason: 'Origin inattendu' });
    expect(journal.verify()).toEqual({ ok: true, count: 2, head: { seq: 2, hash: second.hash } });
  });

  it('journal vide : vérifié, sans tête', () => {
    expect(journal.verify()).toEqual({ ok: true, count: 0, head: null });
  });

  it("trace un refus sans clé connue ni type connu (sonde d'une application compromise)", () => {
    const refused = journal.append(
      entry({ keyId: null, kind: 'unknown', outcome: 'refused', reason: 'opération inconnue', request: {} }),
    );
    expect(refused).toMatchObject({ keyId: null, kind: 'unknown' });
    expect(journal.list({ afterSeq: 0, limit: 10 })[0]).toMatchObject({ keyId: null, outcome: 'refused' });
    expect(journal.verify().ok).toBe(true);
  });

  it('trace le cycle de vie des clés (résultat done), jamais sans clé', () => {
    for (const kind of ['key-generate', 'key-rotate', 'key-retire'] as const) {
      journal.append(entry({ kind, outcome: 'done', contentSha256: sha('clé publique') }));
    }
    expect(() => journal.append(entry({ kind: 'key-generate', outcome: 'done', keyId: null }))).toThrow(
      expect.objectContaining({ code: 'SIGNER_LOG_INVALID' }),
    );
    expect(() => journal.append(entry({ kind: 'apt-release', outcome: 'done' }))).toThrow(
      expect.objectContaining({ code: 'SIGNER_LOG_INVALID' }),
    );
    expect(journal.verify()).toMatchObject({ ok: true, count: 3 });
  });

  it('enregistre la demande en JSON canonique (clés triées) : même demande, même hachage', () => {
    const a = journal.append(entry({ request: { b: 1, a: { d: 2, c: 3 } } }));
    expect(journal.list({ afterSeq: 0, limit: 10 })[0]?.request).toEqual({ a: { c: 3, d: 2 }, b: 1 });
    const row = db.prepare('SELECT request FROM signature_log WHERE seq = ?').get(a.seq) as { request: string };
    expect(row.request).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it.each([
    ['sha256 du contenu mal formé', { contentSha256: 'abc' }],
    ['type inconnu pour une signature', { kind: 'export-private-key' }],
    ['type « unknown » hors refus', { kind: 'unknown' }],
    ['identifiant de clé mal formé', { keyId: 'k1; DROP' }],
    ['clé absente pour une signature', { keyId: null }],
    ['clé inconnue de la base', { keyId: 'inconnue' }],
    ['demande de plus de 4 Kio', { request: { blob: 'x'.repeat(5000) } }],
    ['demande trop profonde', { request: JSON.parse(`${'{"a":'.repeat(10)}1${'}'.repeat(10)}`) }],
    ['demande avec un nombre non fini', { request: { n: Number.POSITIVE_INFINITY } }],
    ['demande avec une valeur non JSON', { request: { f: undefined } }],
    ['motif de refus de plus de 512 caractères', { outcome: 'refused', reason: 'x'.repeat(513) }],
    ['horodatage non entier', { at: 1.5 }],
  ] as const)('refuse une entrée mal formée sans rien écrire : %s', (_label, overrides) => {
    expect(() => journal.append(entry(overrides as Partial<JournalEntry>))).toThrow();
    expect(journal.verify()).toEqual({ ok: true, count: 0, head: null });
  });

  it('une demande très profondément imbriquée lève une erreur typée, pas un dépassement de pile', () => {
    const deep = JSON.parse(`${'{"a":'.repeat(100_000)}1${'}'.repeat(100_000)}`);
    expect(() => journal.append(entry({ request: deep }))).toThrow(
      expect.objectContaining({ code: 'SIGNER_LOG_INVALID' }),
    );
  });

  describe('vérification : toute altération de la chaîne est détectée', () => {
    beforeEach(() => {
      for (let index = 0; index < 4; index += 1) journal.append(entry({ request: { generation: index } }));
      dropTriggers();
    });

    it('champ modifié', () => {
      db.prepare("UPDATE signature_log SET outcome = 'refused' WHERE seq = 2").run();
      expect(journal.verify()).toEqual({ ok: false, brokenAt: 2 });
    });

    it('demande modifiée', () => {
      db.prepare(`UPDATE signature_log SET request = '{"generation":99}' WHERE seq = 3`).run();
      expect(journal.verify()).toEqual({ ok: false, brokenAt: 3 });
    });

    it('hachage précédent seul modifié', () => {
      db.prepare('UPDATE signature_log SET prev_hash = ? WHERE seq = 2').run('a'.repeat(64));
      expect(journal.verify()).toEqual({ ok: false, brokenAt: 2 });
    });

    it('entrée supprimée', () => {
      db.prepare('DELETE FROM signature_log WHERE seq = 3').run();
      expect(journal.verify()).toEqual({ ok: false, brokenAt: 4 });
    });

    it('deux entrées échangées', () => {
      db.exec(`UPDATE signature_log SET seq = 100 WHERE seq = 2;
               UPDATE signature_log SET seq = 2 WHERE seq = 3;
               UPDATE signature_log SET seq = 3 WHERE seq = 100;`);
      expect(journal.verify()).toEqual({ ok: false, brokenAt: 2 });
    });

    it('entrée ajoutée en fin avec un hachage faux', () => {
      const head = db.prepare('SELECT hash FROM signature_log WHERE seq = 4').get() as { hash: string };
      db.prepare(
        `INSERT INTO signature_log (seq, at, key_id, kind, content_sha256, request, outcome, prev_hash, hash)
         VALUES (5, 0, 'k1', 'apt-release', ?, '{}', 'signed', ?, ?)`,
      ).run(sha('x'), head.hash, 'b'.repeat(64));
      expect(journal.verify()).toEqual({ ok: false, brokenAt: 5 });
    });
  });

  it("liste par tranches à partir d'un numéro, bornée à 1 000", () => {
    for (let index = 0; index < 5; index += 1) journal.append(entry({ request: { generation: index } }));
    expect(journal.list({ afterSeq: 2, limit: 2 }).map((record) => record.seq)).toEqual([3, 4]);
    expect(() => journal.list({ afterSeq: 0, limit: 1001 })).toThrow(
      expect.objectContaining({ code: 'SIGNER_LOG_RANGE' }),
    );
  });
});
