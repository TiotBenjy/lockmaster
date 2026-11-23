import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { apkKeyFingerprint } from '../../../src/crypto/apk-rsa.js';
import { generateOpenPgpKey, verifyClearsigned, verifyDetached } from '../../../src/crypto/openpgp.js';
import { encodeFrame } from '../../../src/domain/signer-protocol.js';
import { formatReleaseDate } from '../../../src/formats/deb/release.js';
import { loadSignerConfig } from '../../../src/signer/config.js';
import { SignatureJournal } from '../../../src/signer/journal.js';
import type { KeyGenerators } from '../../../src/signer/operations.js';
import { startSigner } from '../../../src/signer/server.js';
import { openSignerDatabase } from '../../../src/signer/store.js';
import { createSignerClient } from '../../../src/signer-client/client.js';
import { LogCapture } from '../../helpers/deps.js';
import { rawExchange, signerCli, signerInstallation } from '../../helpers/signer.js';

// Opérations de gestion des clés sur le socket du signataire (ADR-0009) : réponses sans clé privée,
// et tout refus d'une demande reçue en entier est journalisé, même sans clé connue.

const NOW = new Date('2026-11-22T10:00:00Z');
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

async function running(options: { requestTimeout?: string; generators?: KeyGenerators } = {}) {
  const install = signerInstallation('', options.requestTimeout ?? '30s');
  cleanups.push(install.cleanup);
  expect((await signerCli(['init', '--config', install.config])).code).toBe(0);
  const logs = new LogCapture();
  const signer = await startSigner(loadSignerConfig({ path: install.config, env: {} }), {
    logDestination: logs,
    clock: { now: () => NOW },
    generators: options.generators ?? generators,
  });
  cleanups.push(() => signer.stop());
  const request = async (message: unknown) => {
    const data = await rawExchange(install.socket, encodeFrame(message));
    return { raw: data.toString('utf8'), response: JSON.parse(data.subarray(4).toString('utf8')) };
  };
  const journal = () => {
    const db = openSignerDatabase(join(install.dataDir, 'signer.db'), { create: false });
    try {
      return new SignatureJournal(db).list({ afterSeq: 0, limit: 100 });
    } finally {
      db.close();
    }
  };
  const keyCount = () => {
    const db = openSignerDatabase(join(install.dataDir, 'signer.db'), { create: false });
    try {
      return (db.prepare('SELECT count(*) AS n FROM key').get() as { n: number }).n;
    } finally {
      db.close();
    }
  };
  const client = createSignerClient({ socketPath: install.socket, timeoutMs: 10_000 });
  return { request, journal, client, logs, keyCount, dataDir: install.dataDir };
}

const identity = { repoName: 'debian-12', repoFormat: 'deb', originLabel: 'lockmaster-debian-12', allowedNames: ['*'] };

describe('opérations du socket', () => {
  it('status et list-keys sur un signataire vide', async () => {
    const { request } = await running();
    expect((await request({ op: 'status' })).response).toEqual({
      ok: true,
      result: { keys: { active: 0, rotating_in: 0, rotating_out: 0, retired: 0 }, journalHead: null },
    });
    expect((await request({ op: 'list-keys' })).response).toEqual({ ok: true, result: { keys: [] } });
  });

  it('generate-key, rotate-key, retire-key : réponses sans clé privée, journalisées', async () => {
    const { request, journal } = await running();
    const generated = await request({ op: 'generate-key', purpose: 'repo', kind: 'openpgp', identity });
    expect(generated.response.ok).toBe(true);
    expect(generated.raw).not.toContain('PRIVATE');
    const keyId = generated.response.result.key.id as string;
    const rotated = await request({ op: 'rotate-key', keyId });
    expect(rotated.raw).not.toContain('PRIVATE');
    const retired = await request({ op: 'retire-key', keyId });
    expect(retired.response).toMatchObject({ ok: true, result: { key: { id: keyId, state: 'retired' } } });
    expect(journal().map((entry) => [entry.kind, entry.outcome])).toEqual([
      ['key-generate', 'done'],
      ['key-rotate', 'done'],
      ['key-retire', 'done'],
    ]);
    const log = await request({ op: 'log', afterSeq: 0, limit: 10 });
    expect(log.response.result.entries).toHaveLength(3);
    expect(log.response.result.head.seq).toBe(3);
  });

  it("journalise le refus d'une opération inconnue, sans clé (sonde d'une application compromise)", async () => {
    const { request, journal } = await running();
    const refused = await request({ op: 'export-private-key', keyId: 'k' });
    expect(refused.response).toMatchObject({ ok: false, error: { code: 'SIGNER_UNKNOWN_OPERATION' } });
    expect(journal()).toEqual([
      expect.objectContaining({
        kind: 'unknown',
        keyId: null,
        outcome: 'refused',
        reason: 'SIGNER_UNKNOWN_OPERATION',
        at: NOW.getTime(),
      }),
    ]);
  });

  it("journalise le refus d'une rotation de clé inconnue (key_id nul) et d'une génération en double", async () => {
    const { request, journal } = await running();
    expect((await request({ op: 'rotate-key', keyId: 'inconnue' })).response.error.code).toBe('KEY_NOT_FOUND');
    await request({ op: 'generate-key', purpose: 'audit' });
    expect((await request({ op: 'generate-key', purpose: 'audit' })).response.error.code).toBe('KEY_EXISTS');
    const entries = journal();
    expect(entries.map((entry) => [entry.kind, entry.keyId, entry.outcome, entry.reason])).toEqual([
      ['key-rotate', null, 'refused', 'KEY_NOT_FOUND'],
      ['key-generate', entries[1]?.keyId, 'done', undefined],
      ['key-generate', null, 'refused', 'KEY_EXISTS'],
    ]);
  });

  it("journalise le refus d'une requête mal formée, et la rotation refusée d'une clé connue avec son identifiant", async () => {
    const { request, journal } = await running();
    expect((await request({ op: 'generate-key', purpose: 'audit', privateKey: 'x' })).response.error.code).toBe(
      'SIGNER_REQUEST_INVALID',
    );
    const keyId = (await request({ op: 'generate-key', purpose: 'audit' })).response.result.key.id as string;
    await request({ op: 'retire-key', keyId });
    expect((await request({ op: 'rotate-key', keyId })).response.error.code).toBe('KEY_STATE_CONFLICT');
    const entries = journal();
    expect(entries[0]).toMatchObject({
      kind: 'key-generate',
      keyId: null,
      outcome: 'refused',
      reason: 'SIGNER_REQUEST_INVALID',
    });
    expect(entries.at(-1)).toMatchObject({
      kind: 'key-rotate',
      keyId,
      outcome: 'refused',
      reason: 'KEY_STATE_CONFLICT',
    });
  });

  it("aller-retour avec le client de l'application : résultats acceptés par ses schémas stricts", async () => {
    const { client } = await running();
    const generated = await client.generateKey({
      purpose: 'repo',
      kind: 'openpgp',
      identity: { ...identity, repoFormat: 'deb' },
    });
    expect(generated.key.state).toBe('active');
    expect(generated.revocationCertificate).toContain('PGP');
    expect((await client.listKeys()).map((key) => key.id)).toEqual([generated.key.id]);
    expect((await client.status()).keys.active).toBe(1);
    expect((await client.log({ afterSeq: 0, limit: 10 })).entries).toHaveLength(1);
    const rotated = await client.rotateKey(generated.key.id);
    expect((await client.retireKey(generated.key.id)).state).toBe('retired');
    expect((await client.listKeys()).find((key) => key.id === rotated.key.id)?.state).toBe('active');
    await expect(client.rotateKey('inconnue')).rejects.toMatchObject({ code: 'KEY_NOT_FOUND' });
  });

  it('échéance dépassée pendant la génération : SIGNER_TIMEOUT, aucune clé enregistrée, refus journalisé', async () => {
    let release: () => void = () => {};
    const generated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: KeyGenerators = {
      ...generators,
      async openpgp(request) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const key = await generators.openpgp(request);
        release();
        return key;
      },
    };
    const { request, journal, keyCount } = await running({ requestTimeout: '1s', generators: slow });
    const refused = await request({ op: 'generate-key', purpose: 'audit' });
    expect(refused.response).toMatchObject({ ok: false, error: { code: 'SIGNER_TIMEOUT' } });
    await generated;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(keyCount()).toBe(0);
    expect(journal()).toEqual([
      expect.objectContaining({ kind: 'key-generate', keyId: null, outcome: 'refused', reason: 'SIGNER_TIMEOUT' }),
    ]);
  });

  it('chaque entrée du journal est annoncée dans journald avec son numéro et son hachage (tête exportable)', async () => {
    const { request, journal, logs } = await running();
    await request({ op: 'generate-key', purpose: 'audit' });
    await request({ op: 'rotate-key', keyId: 'inconnue' });
    const events = logs.lines.filter((line) => line['event'] === 'signer.journal_appended');
    expect(events.map((event) => [event['seq'], event['hash'], event['outcome']])).toEqual(
      journal().map((entry) => [entry.seq, entry.hash, entry.outcome]),
    );
    expect(logs.text()).not.toContain('PRIVATE');
  });

  it("rotation refusée pour identité modifiée en base : refus journalisé avec l'identifiant de la clé", async () => {
    const { request, journal, dataDir } = await running();
    const keyId = (await request({ op: 'generate-key', purpose: 'repo', kind: 'openpgp', identity })).response.result
      .key.id as string;
    const db = openSignerDatabase(join(dataDir, 'signer.db'), { create: false });
    db.prepare(`UPDATE key SET allowed_names = '["*", "openssl"]' WHERE id = ?`).run(keyId);
    db.close();
    expect((await request({ op: 'rotate-key', keyId })).response.error.code).toBe('CRYPTO_UNSEAL_FAILED');
    expect(journal().at(-1)).toMatchObject({
      kind: 'key-rotate',
      keyId,
      outcome: 'refused',
      reason: 'CRYPTO_UNSEAL_FAILED',
    });
  });

  it('signatures par le client : Release et point de contrôle, vérifiables avec la clé publique', async () => {
    const { client } = await running();
    const repo = (
      await client.generateKey({ purpose: 'repo', kind: 'openpgp', identity: { ...identity, repoFormat: 'deb' } })
    ).key;
    const content = [
      'Origin: lockmaster-debian-12',
      'Label: lockmaster-debian-12 stable',
      'Suite: stable',
      `Date: ${formatReleaseDate(NOW)}`,
      `Valid-Until: ${formatReleaseDate(new Date(NOW.getTime() + 7 * 86_400_000))}`,
      'SHA256:',
      ` ${'a'.repeat(64)} 1 main/binary-amd64/Packages`,
      '',
    ].join('\n');
    const signed = await client.signAptRelease(repo.id, content, {
      repo: 'debian-12',
      channel: 'stable',
      generation: 3,
    });
    expect(await verifyClearsigned(repo.publicKey, signed.inRelease, NOW)).toBe(content);
    const audit = (await client.generateKey({ purpose: 'audit' })).key;
    const checkpoint = await client.signAuditCheckpoint(audit.id, { seq: 1, hash: 'c'.repeat(64), at: NOW.getTime() });
    const payload = new TextEncoder().encode(checkpoint.payload);
    await expect(verifyDetached(audit.publicKey, payload, checkpoint.signature, NOW)).resolves.toBeUndefined();
  });
});
