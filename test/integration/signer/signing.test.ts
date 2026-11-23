import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apkKeyFingerprint } from '../../../src/crypto/apk-rsa.js';
import { generateOpenPgpKey, verifyClearsigned, verifyDetached } from '../../../src/crypto/openpgp.js';
import { createIdGenerator } from '../../../src/domain/id.js';
import type { SignRequest } from '../../../src/domain/signer-protocol.js';
import { formatReleaseDate } from '../../../src/formats/deb/release.js';
import { SignatureJournal } from '../../../src/signer/journal.js';
import { SqliteKeyStore } from '../../../src/signer/keystore-sqlite.js';
import { migrateSignerDatabase } from '../../../src/signer/migrations.js';
import { type KeyGenerators, SignerOperations } from '../../../src/signer/operations.js';
import { RateLimiter } from '../../../src/signer/rate-limit.js';
import { SignerSigning } from '../../../src/signer/signing.js';
import { runTransaction } from '../../../src/system/sqlite-tx.js';
import { FakeRandom } from '../../fakes/random.js';

// Demande `sign` (ADR-0009) : contrôles par type de demande avant toute signature, limite de débit par
// clé, signature journalisée. Les refus sont journalisés par le routeur (socket-operations.test.ts).

const NOW = new Date('2026-11-22T10:00:00Z');
const clock = { now: () => NOW };
const identity = {
  repoName: 'debian-12',
  repoFormat: 'deb' as const,
  originLabel: 'lockmaster-debian-12',
  allowedNames: ['*'],
};
const DAY = 86_400_000;

let db: Database.Database;
let journal: SignatureJournal;
let keys: SqliteKeyStore;
let operations: SignerOperations;
let expiresAt: number;

const generators: KeyGenerators = {
  async openpgp({ name, date }) {
    const key = await generateOpenPgpKey({
      name,
      type: 'ed25519',
      date: new Date(date.getTime() - DAY),
      validityDays: 730,
    });
    return { ...key, expiresAt };
  },
  async apk() {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    return {
      publicKey: publicKeyPem,
      privateKey: privateKeyPem,
      fingerprint: apkKeyFingerprint(publicKeyPem),
      expiresAt: null,
    };
  },
};

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = ON');
  migrateSignerDatabase(db, 0);
  journal = new SignatureJournal(db);
  keys = new SqliteKeyStore(db, randomBytes(32));
  expiresAt = NOW.getTime() + 700 * DAY;
  operations = new SignerOperations({
    keys,
    journal,
    clock,
    newId: createIdGenerator(clock, new FakeRandom('signing')),
    atomic: (fn) => runTransaction(db, fn),
    generators,
  });
});
afterEach(() => db.close());

const LIMITS = { maxClockSkewMs: 5 * 60_000, maxValidUntilDays: 30 };
const signing = (limit = 120) =>
  new SignerSigning({ keys, journal, clock, rate: new RateLimiter(db, limit), limits: LIMITS });

function release(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    Origin: 'lockmaster-debian-12',
    Label: 'lockmaster-debian-12 stable',
    Suite: 'stable',
    Date: formatReleaseDate(NOW),
    'Valid-Until': formatReleaseDate(new Date(NOW.getTime() + 7 * DAY)),
    ...overrides,
  };
  const head = Object.entries(fields)
    .filter(([, value]) => value !== '')
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
  return `${head}\nSHA256:\n ${'a'.repeat(64)} 1234 main/binary-amd64/Packages\n`;
}

const aptRequest = (
  keyId: string,
  content: string,
  context = { repo: 'debian-12', channel: 'stable', generation: 42 },
): SignRequest => ({
  op: 'sign',
  keyId,
  kind: 'apt-release',
  content,
  context,
});

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? `erreur sans code : ${(error as Error).message}`;
  }
}

const repoKey = async () =>
  (await operations.generateKey({ op: 'generate-key', purpose: 'repo', kind: 'openpgp', identity })).key;

describe('sign : apt-release', () => {
  it('signe en clair (InRelease) et en détaché (Release.gpg), vérifiables avec la clé publique, et journalise', async () => {
    const key = await repoKey();
    const content = release();
    const result = (await signing().sign(aptRequest(key.id, content))) as { inRelease: string; releaseGpg: string };
    expect(await verifyClearsigned(key.publicKey, result.inRelease, NOW)).toBe(content);
    await expect(
      verifyDetached(key.publicKey, new TextEncoder().encode(content), result.releaseGpg, NOW),
    ).resolves.toBeUndefined();
    expect(journal.list({ afterSeq: 0, limit: 10 }).at(-1)).toMatchObject({
      kind: 'apt-release',
      outcome: 'signed',
      keyId: key.id,
      at: NOW.getTime(),
      contentSha256: createHash('sha256').update(content).digest('hex'),
      request: { repo: 'debian-12', channel: 'stable', generation: 42 },
    });
  });

  it.each([
    ['Origin étranger', release({ Origin: 'debian' }), 'SIGNER_CHECK_IDENTITY'],
    ['Label étranger', release({ Label: 'debian stable' }), 'SIGNER_CHECK_IDENTITY'],
    ['Label avec un autre canal', release({ Label: 'lockmaster-debian-12 testing' }), 'SIGNER_CHECK_IDENTITY'],
    ["Signed-By d'une autre clé", release({ 'Signed-By': 'f'.repeat(40) }), 'SIGNER_CHECK_IDENTITY'],
    [
      'Date en avance de 6 minutes',
      release({ Date: formatReleaseDate(new Date(NOW.getTime() + 6 * 60_000)) }),
      'SIGNER_CHECK_DATE',
    ],
    [
      'Date en retard de 6 minutes',
      release({ Date: formatReleaseDate(new Date(NOW.getTime() - 6 * 60_000)) }),
      'SIGNER_CHECK_DATE',
    ],
    [
      'Valid-Until au-delà de 30 jours',
      release({ 'Valid-Until': formatReleaseDate(new Date(NOW.getTime() + 31 * DAY)) }),
      'SIGNER_CHECK_VALIDITY',
    ],
    [
      'Valid-Until antérieur à Date',
      release({ 'Valid-Until': formatReleaseDate(new Date(NOW.getTime() - DAY)) }),
      'SIGNER_CHECK_VALIDITY',
    ],
    ['contenu arbitraire', 'Bonjour, signe ceci.\n', 'SIGNER_CHECK_FORMAT'],
    ['champ inattendu', `${release()}Evil: 1\n`, 'SIGNER_CHECK_FORMAT'],
  ])('refuse avant de signer : %s', async (_label, content, code) => {
    const key = await repoKey();
    expect(await codeOf(() => signing().sign(aptRequest(key.id, content)))).toBe(code);
    expect(journal.list({ afterSeq: 0, limit: 10 }).filter((entry) => entry.outcome === 'signed')).toEqual([]);
  });

  it('refuse un contexte déclaré qui ne correspond pas à la clé ou au Release', async () => {
    const key = await repoKey();
    const otherRepo = { repo: 'rocky-9', channel: 'stable', generation: 1 };
    expect(await codeOf(() => signing().sign(aptRequest(key.id, release(), otherRepo)))).toBe('SIGNER_CHECK_IDENTITY');
    const otherChannel = { repo: 'debian-12', channel: 'testing', generation: 1 };
    expect(await codeOf(() => signing().sign(aptRequest(key.id, release(), otherChannel)))).toBe(
      'SIGNER_CHECK_IDENTITY',
    );
  });

  it("refuse une clé d'un autre usage ou format, inconnue, retirée, en sortie de rotation ou expirée", async () => {
    const audit = (await operations.generateKey({ op: 'generate-key', purpose: 'audit' })).key;
    expect(await codeOf(() => signing().sign(aptRequest(audit.id, release())))).toBe('SIGNER_KEY_PURPOSE');
    const apk = (
      await operations.generateKey({
        op: 'generate-key',
        purpose: 'repo',
        kind: 'apk-rsa',
        identity: { ...identity, repoName: 'alpine-3', repoFormat: 'apk' },
      })
    ).key;
    expect(await codeOf(() => signing().sign(aptRequest(apk.id, release())))).toBe('SIGNER_KEY_PURPOSE');
    expect(await codeOf(() => signing().sign(aptRequest('inconnue', release())))).toBe('KEY_NOT_FOUND');
    const key = await repoKey();
    const { key: fresh } = await operations.rotateKey(key.id);
    expect(await codeOf(() => signing().sign(aptRequest(key.id, release())))).toBe('KEY_STATE_CONFLICT');
    await expect(signing().sign(aptRequest(fresh.id, release()))).resolves.toHaveProperty('inRelease');
    operations.retireKey(fresh.id);
    expect(await codeOf(() => signing().sign(aptRequest(fresh.id, release())))).toBe('KEY_RETIRED');
    expiresAt = NOW.getTime() - 1;
    const expired = (
      await operations.generateKey({
        op: 'generate-key',
        purpose: 'repo',
        kind: 'openpgp',
        identity: { ...identity, repoName: 'debian-13', originLabel: 'lockmaster-debian-13' },
      })
    ).key;
    expect(
      await codeOf(() =>
        signing().sign(aptRequest(expired.id, release(), { repo: 'debian-13', channel: 'stable', generation: 1 })),
      ),
    ).toBe('KEY_EXPIRED');
  });

  it('limite de débit par clé et par minute, refus compris', async () => {
    const key = await repoKey();
    const limited = signing(3);
    expect(await codeOf(() => limited.sign(aptRequest(key.id, 'arbitraire\n')))).toBe('SIGNER_CHECK_FORMAT');
    await limited.sign(aptRequest(key.id, release()));
    await limited.sign(aptRequest(key.id, release()));
    expect(await codeOf(() => limited.sign(aptRequest(key.id, release())))).toBe('SIGNER_RATE_LIMITED');
  });

  it('limite de débit indépendante par clé, remise à zéro à la minute suivante', async () => {
    const key = await repoKey();
    const other = (await operations.generateKey({ op: 'generate-key', purpose: 'audit' })).key;
    let now = NOW;
    const moving = new SignerSigning({
      keys,
      journal,
      clock: { now: () => now },
      rate: new RateLimiter(db, 1),
      limits: LIMITS,
    });
    await moving.sign(aptRequest(key.id, release()));
    expect(await codeOf(() => moving.sign(aptRequest(key.id, release())))).toBe('SIGNER_RATE_LIMITED');
    const checkpoint = { seq: 1, hash: 'b'.repeat(64), at: 0 };
    await expect(
      moving.sign({ op: 'sign', keyId: other.id, kind: 'audit-checkpoint', checkpoint }),
    ).resolves.toBeDefined();
    now = new Date(NOW.getTime() + 60_000);
    const nextMinute = release({
      Date: formatReleaseDate(now),
      'Valid-Until': formatReleaseDate(new Date(now.getTime() + DAY)),
    });
    await expect(moving.sign(aptRequest(key.id, nextMinute))).resolves.toHaveProperty('inRelease');
  });

  it.each([
    ['blanc en fin de ligne', release().replace('Suite: stable', 'Suite: stable  ')],
    ['ligne vide en tête', `\n${release()}`],
    ['saut de ligne final en double', `${release()}\n`],
    ['sans saut de ligne final', release().trimEnd()],
    ['fins de ligne CRLF', release().replaceAll('\n', '\r\n')],
  ])('refuse un Release hors de sa forme canonique : %s', async (_label, content) => {
    const key = await repoKey();
    expect(await codeOf(() => signing().sign(aptRequest(key.id, content)))).toBe('SIGNER_CHECK_FORMAT');
  });

  it('exige un Label qui inclut le canal (SEC-05)', async () => {
    const key = await repoKey();
    expect(await codeOf(() => signing().sign(aptRequest(key.id, release({ Label: 'lockmaster-debian-12' }))))).toBe(
      'SIGNER_CHECK_IDENTITY',
    );
  });

  it('bornes exactes : Date à plus ou moins 5 minutes et Valid-Until à 30 jours acceptés, Signed-By de la clé accepté', async () => {
    const key = await repoKey();
    for (const offset of [5 * 60_000, -5 * 60_000]) {
      const date = new Date(NOW.getTime() + offset);
      const content = release({
        Date: formatReleaseDate(date),
        'Valid-Until': formatReleaseDate(new Date(date.getTime() + 30 * DAY)),
      });
      await expect(signing().sign(aptRequest(key.id, content))).resolves.toHaveProperty('inRelease');
    }
    const same = release({ 'Valid-Until': formatReleaseDate(NOW) });
    expect(await codeOf(() => signing().sign(aptRequest(key.id, same)))).toBe('SIGNER_CHECK_VALIDITY');
    await expect(
      signing().sign(aptRequest(key.id, release({ 'Signed-By': key.fingerprint.toUpperCase() }))),
    ).resolves.toHaveProperty('releaseGpg');
  });
});

describe('sign : aucune signature rendue sans son entrée signed au journal', () => {
  const signedEntries = () => journal.list({ afterSeq: 0, limit: 100 }).filter((entry) => entry.outcome === 'signed');

  it('échéance passée pendant la signature : SIGNER_TIMEOUT, rien de journalisé comme signé', async () => {
    const key = await repoKey();
    expect(await codeOf(() => signing().sign(aptRequest(key.id, release()), AbortSignal.abort()))).toBe(
      'SIGNER_TIMEOUT',
    );
    expect(signedEntries()).toEqual([]);
  });

  it("journal en échec : la signature n'est pas rendue", async () => {
    const key = await repoKey();
    const failing = {
      append: () => {
        throw new Error('disque plein');
      },
    } as unknown as SignatureJournal;
    const broken = new SignerSigning({ keys, journal: failing, clock, rate: new RateLimiter(db, 10), limits: LIMITS });
    await expect(broken.sign(aptRequest(key.id, release()))).rejects.toThrow('disque plein');
  });

  it('clé retirée pendant la signature : refus, rien de journalisé comme signé', async () => {
    const key = await repoKey();
    const pending = signing().sign(aptRequest(key.id, release()));
    operations.retireKey(key.id);
    expect(await codeOf(() => pending)).toBe('KEY_RETIRED');
    expect(signedEntries()).toEqual([]);
  });
});

describe('sign : audit-checkpoint', () => {
  it("signe uniquement le JSON canonique de {seq, hash, at} avec la clé d'audit", async () => {
    const audit = (await operations.generateKey({ op: 'generate-key', purpose: 'audit' })).key;
    const checkpoint = { seq: 7, hash: 'b'.repeat(64), at: NOW.getTime() };
    const result = (await signing().sign({ op: 'sign', keyId: audit.id, kind: 'audit-checkpoint', checkpoint })) as {
      payload: string;
      signature: string;
    };
    expect(result.payload).toBe(`{"at":${NOW.getTime()},"hash":"${'b'.repeat(64)}","seq":7}`);
    await expect(
      verifyDetached(audit.publicKey, new TextEncoder().encode(result.payload), result.signature, NOW),
    ).resolves.toBeUndefined();
    expect(journal.list({ afterSeq: 0, limit: 10 }).at(-1)).toMatchObject({
      kind: 'audit-checkpoint',
      outcome: 'signed',
      request: { seq: 7 },
    });
  });

  it('refuse une clé de dépôt pour un point de contrôle', async () => {
    const key = await repoKey();
    const checkpoint = { seq: 1, hash: 'b'.repeat(64), at: 0 };
    expect(
      await codeOf(() => signing().sign({ op: 'sign', keyId: key.id, kind: 'audit-checkpoint', checkpoint })),
    ).toBe('SIGNER_KEY_PURPOSE');
  });
});
