import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { apkKeyFingerprint } from '../../src/crypto/apk-rsa.js';
import { parseMasterKey } from '../../src/crypto/master-key.js';
import { generateOpenPgpKey } from '../../src/crypto/openpgp.js';
import { encodeFrame } from '../../src/domain/signer-protocol.js';
import { loadSignerConfig } from '../../src/signer/config.js';
import { SignatureJournal } from '../../src/signer/journal.js';
import { SqliteKeyStore } from '../../src/signer/keystore-sqlite.js';
import type { KeyGenerators } from '../../src/signer/operations.js';
import { startSigner } from '../../src/signer/server.js';
import { openSignerDatabase } from '../../src/signer/store.js';
import { LogCapture } from '../helpers/deps.js';
import { rawExchange, signerCli, signerInstallation } from '../helpers/signer.js';

// SEC-07 (docs/11, ADR-0009) : les clés privées n'existent que dans le signataire. Aucune opération du
// socket ne rend une clé privée ; une demande non conforme est refusée ET journalisée ; les opérations
// concurrentes sur une même lignée de clés ne créent jamais deux clés.

const generators: KeyGenerators = {
  async openpgp({ name, date }) {
    const key = await generateOpenPgpKey({ name, type: 'ed25519', date, validityDays: 730 });
    return { ...key, expiresAt: date.getTime() + 730 * 86_400_000 };
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

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function signer() {
  const install = signerInstallation();
  cleanups.push(install.cleanup);
  expect((await signerCli(['init', '--config', install.config])).code).toBe(0);
  const running = await startSigner(loadSignerConfig({ path: install.config, env: {} }), {
    logDestination: new LogCapture(),
    generators,
  });
  cleanups.push(() => running.stop());
  const send = async (message: unknown) => {
    const raw = await rawExchange(install.socket, encodeFrame(message));
    return { raw: raw.toString('utf8'), response: JSON.parse(raw.subarray(4).toString('utf8')) };
  };
  const inspect = <T>(read: (keys: SqliteKeyStore, journal: SignatureJournal) => T): T => {
    const db = openSignerDatabase(join(install.dataDir, 'signer.db'), { create: false });
    try {
      const masterKey = parseMasterKey(readFileSync(install.keyFile));
      return read(new SqliteKeyStore(db, masterKey), new SignatureJournal(db));
    } finally {
      db.close();
    }
  };
  return { send, inspect };
}

const debIdentity = {
  repoName: 'debian-12',
  repoFormat: 'deb',
  originLabel: 'lockmaster-debian-12',
  allowedNames: ['*'],
};
const apkIdentity = {
  repoName: 'alpine-3',
  repoFormat: 'apk',
  originLabel: 'lockmaster-alpine-3',
  allowedNames: ['*'],
};

/** Lignes du corps d'une clé privée (base64), pour les chercher dans une réponse brute. */
const secretLines = (privateKey: string) => privateKey.split('\n').filter((line) => line.length >= 40);

describe('SEC-07 : aucune opération du socket ne rend une clé privée', () => {
  it.each([
    ['OpenPGP', { purpose: 'repo', kind: 'openpgp', identity: debIdentity }],
    ['RSA APK', { purpose: 'repo', kind: 'apk-rsa', identity: apkIdentity }],
    ["OpenPGP d'audit", { purpose: 'audit' }],
  ])('%s : génération, rotation, liste, état, journal et retrait', async (_label, request) => {
    const { send, inspect } = await signer();
    const responses: string[] = [];
    const generated = await send({ op: 'generate-key', ...request });
    const firstId = generated.response.result.key.id as string;
    const rotated = await send({ op: 'rotate-key', keyId: firstId });
    const secondId = rotated.response.result.key.id as string;
    const secrets = inspect((keys) => [keys.privateKey(firstId), keys.privateKey(secondId)]);
    responses.push(generated.raw, rotated.raw);
    for (const message of [{ op: 'list-keys' }, { op: 'status' }, { op: 'log', afterSeq: 0, limit: 1000 }]) {
      responses.push((await send(message)).raw);
    }
    responses.push((await send({ op: 'retire-key', keyId: firstId })).raw);
    for (const raw of responses) {
      expect(raw).not.toMatch(/PRIVATE KEY/);
      for (const line of secrets.flatMap(secretLines)) expect(raw).not.toContain(line);
    }
  });
});

describe('SEC-07 : demande non conforme refusée et journalisée', () => {
  it.each([
    ['opération inconnue', { op: 'export-private-key', keyId: 'k' }, 'SIGNER_UNKNOWN_OPERATION'],
    ['clé privée fournie', { op: 'generate-key', purpose: 'audit', privateKey: 'x' }, 'SIGNER_REQUEST_INVALID'],
    [
      "modification d'identité par rotation",
      { op: 'rotate-key', keyId: 'k', identity: debIdentity },
      'SIGNER_REQUEST_INVALID',
    ],
    [
      'identité invalide',
      {
        op: 'generate-key',
        purpose: 'repo',
        kind: 'openpgp',
        identity: { ...debIdentity, originLabel: 'a\nOrigin: b' },
      },
      'KEY_INVALID',
    ],
    ['clé inconnue', { op: 'retire-key', keyId: 'inconnue' }, 'KEY_NOT_FOUND'],
  ])('%s', async (_label, message, code) => {
    const { send, inspect } = await signer();
    expect((await send(message)).response).toMatchObject({ ok: false, error: { code } });
    const entries = inspect((_keys, journal) => journal.list({ afterSeq: 0, limit: 10 }));
    expect(entries).toEqual([expect.objectContaining({ outcome: 'refused', reason: code })]);
    expect(inspect((keys) => keys.list())).toEqual([]);
  });
});

describe('SEC-07 : opérations concurrentes sur une même lignée', () => {
  it("deux générations simultanées : une seule clé, l'autre refusée et journalisée", async () => {
    const { send, inspect } = await signer();
    const results = await Promise.all([1, 2].map(() => send({ op: 'generate-key', purpose: 'audit' })));
    expect(results.map((result) => result.response.ok).sort()).toEqual([false, true]);
    expect(inspect((keys) => keys.list())).toHaveLength(1);
    expect(
      inspect((_keys, journal) => journal.list({ afterSeq: 0, limit: 10 }))
        .map((entry) => entry.outcome)
        .sort(),
    ).toEqual(['done', 'refused']);
  });

  it('deux rotations simultanées : une seule nouvelle clé', async () => {
    const { send, inspect } = await signer();
    const keyId = (await send({ op: 'generate-key', purpose: 'audit' })).response.result.key.id as string;
    const results = await Promise.all([1, 2].map(() => send({ op: 'rotate-key', keyId })));
    expect(results.map((result) => result.response.ok).sort()).toEqual([false, true]);
    expect(
      inspect((keys) =>
        keys
          .list()
          .map((key) => key.state)
          .sort(),
      ),
    ).toEqual(['rotating_in', 'rotating_out']);
  });
});
