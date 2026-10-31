import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../../../src/db/connection.js';
import { APP_MIGRATIONS, migrateDatabase } from '../../../src/db/migrations.js';
import { REPO_ROOT } from '../../helpers/run-script.js';

// Schéma de l'application (docs/05) : 0001_init.sql reproduit exactement le document, et les
// contraintes qui portent des invariants de sécurité (4 yeux, audit append-only, noms) tiennent.

const NOW = 1_800_000_000_000;
let db: Db;
beforeEach(() => {
  db = openDatabase(':memory:', { create: true });
  migrateDatabase(db, NOW);
});
afterEach(() => db.close());

/** Instructions SQL sans commentaires ni espaces superflus, pour comparer deux textes. */
function statements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((part) => part.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim())
    .filter((part) => part !== '');
}

function documentedSchema(): string {
  const doc = readFileSync(join(REPO_ROOT, 'docs/05-modele-de-donnees.md'), 'utf8');
  const start = doc.indexOf('```sql', doc.indexOf('## Tables'));
  return doc.slice(start + '```sql'.length, doc.indexOf('```', start + 1));
}

const run = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params);

function seedPackage(uploader: string): void {
  run(
    "INSERT INTO account (id, username, password_hash, auth_source, created_at) VALUES (?, ?, 'x', 'local', 0)",
    uploader,
    uploader,
  );
  run(
    "INSERT INTO account (id, username, password_hash, auth_source, created_at) VALUES ('rev', 'rev', 'x', 'local', 0)",
  );
  run(
    "INSERT INTO repository (id, name, format, distro, origin_label, created_at) VALUES ('r', 'debian-12', 'deb', 'debian-12', 'o', 0)",
  );
  run(
    `INSERT INTO artifact (sha256, sha512, sha1, md5, size, format, created_at) VALUES (?, 'a', 'b', 'c', 1, 'deb', 0)`,
    'f'.repeat(64),
  );
  run(
    `INSERT INTO package_version (id, repo_id, artifact, name, version, arch, metadata, state, origin, uploaded_by, created_at, updated_at)
     VALUES ('p', 'r', ?, 'hello', '1.0', 'amd64', '{}', 'pending_review', 'upload', ?, 0, 0)`,
    'f'.repeat(64),
    uploader,
  );
}

const humanDecision = (actor: string) =>
  run(
    "INSERT INTO decision (id, package_id, verdict, source, actor, reason, created_at) VALUES (?, 'p', 'allow', 'human', ?, ?, 0)",
    `d-${actor}`,
    actor,
    'justification suffisamment longue',
  );

describe("schéma de la base de l'application", () => {
  it('0001_init.sql est identique au schéma de docs/05', () => {
    const migration = APP_MIGRATIONS[0];
    expect(migration?.name).toBe('init');
    expect(statements(migration?.sql ?? '')).toEqual(statements(documentedSchema()));
  });

  it('une base neuve est intègre et sans référence pendante', () => {
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(migrateDatabase(db, NOW)).toEqual([]);
  });

  it('4 yeux : un uploader ne peut pas approuver son propre paquet', () => {
    seedPackage('alice');
    expect(() => humanDecision('alice')).toThrow(/four-eyes/);
    expect(() => humanDecision('rev')).not.toThrow();
    run("INSERT INTO setting (key, value, updated_at) VALUES ('review.allow_self_approval', '1', 0)");
    expect(() => humanDecision('alice')).not.toThrow();
  });

  it('une décision humaine exige un acteur et une justification de 20 caractères', () => {
    seedPackage('alice');
    expect(() =>
      run(
        "INSERT INTO decision (id, package_id, verdict, source, actor, reason, created_at) VALUES ('d', 'p', 'block', 'human', 'rev', 'trop court', 0)",
      ),
    ).toThrow(/reason/);
  });

  it('décisions et audit sont append-only ; seule la purge autorisée supprime', () => {
    seedPackage('alice');
    humanDecision('rev');
    expect(() => run("UPDATE decision SET reason = 'x' WHERE id = 'd-rev'")).toThrow(/append-only/);
    run(
      "INSERT INTO audit_event (seq, at, actor, action, details, prev_hash, hash) VALUES (1, 0, 'system', 'x', '{}', 'a', 'b')",
    );
    expect(() => run("UPDATE audit_event SET actor = 'mallory'")).toThrow(/append-only/);
    expect(() => run('DELETE FROM audit_event')).toThrow(/append-only/);
    run("INSERT INTO setting (key, value, updated_at) VALUES ('audit.purge_in_progress', '1', 0)");
    expect(run('DELETE FROM audit_event').changes).toBe(1);
  });

  it.each(['../etc', 'Debian', '-x', 'a..b', 'a/b', ''])('refuse le nom de dépôt « %s »', (name) => {
    expect(() =>
      run(
        "INSERT INTO repository (id, name, format, distro, origin_label, created_at) VALUES ('x', ?, 'deb', 'd', 'o', 0)",
        name,
      ),
    ).toThrow(/CHECK/);
  });

  it('les rôles admin et auditor ne se limitent pas à un dépôt (ADR-0010)', () => {
    run(
      "INSERT INTO repository (id, name, format, distro, origin_label, created_at) VALUES ('r', 'debian-12', 'deb', 'd', 'o', 0)",
    );
    run("INSERT INTO local_group (id, name, created_at) VALUES ('g', 'ops', 0)");
    const role = (role: string, repo: string | null) =>
      run(
        "INSERT INTO group_role (id, group_kind, local_group_id, role, repo_id, created_by, created_at) VALUES (?, 'local', 'g', ?, ?, 'system', 0)",
        `${role}-${repo}`,
        role,
        repo,
      );
    expect(() => role('admin', 'r')).toThrow(/CHECK/);
    expect(() => role('auditor', 'r')).toThrow(/CHECK/);
    expect(() => role('maintainer', 'r')).not.toThrow();
    expect(() => role('admin', null)).not.toThrow();
  });
});

describe('fichiers de la base', () => {
  it("ouvre avec clés étrangères et délai d'attente", () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });
});
