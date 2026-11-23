import * as openpgp from 'openpgp';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  clearsign,
  detachSign,
  type GeneratedOpenPgpKey,
  generateOpenPgpKey,
  OPENPGP_KEY_VALIDITY_DAYS,
  openPgpKeyType,
  verifyClearsigned,
  verifyDetached,
} from '../../../src/crypto/openpgp.js';

const DATE = new Date('2026-11-22T10:00:00Z');
const LATER = new Date('2026-12-01T10:00:00Z');
const RELEASE = 'Origin: lockmaster-depot\nLabel: lockmaster-depot stable\nSuite: stable\n';
const DATA = new TextEncoder().encode(RELEASE);
const DAY = 86_400_000;

let rsa: GeneratedOpenPgpKey;
let ed: GeneratedOpenPgpKey;
let expired: GeneratedOpenPgpKey;
beforeAll(async () => {
  const validityDays = OPENPGP_KEY_VALIDITY_DAYS;
  [rsa, ed, expired] = await Promise.all([
    generateOpenPgpKey({ name: 'Lockmaster depot', type: 'rsa4096', date: DATE, validityDays }),
    generateOpenPgpKey({ name: 'Autre', type: 'ed25519', date: DATE, validityDays }),
    // Clé valide un jour à partir de DATE : expirée à LATER.
    generateOpenPgpKey({ name: 'Ancienne', type: 'ed25519', date: DATE, validityDays: 1 }),
  ]);
}, 60_000);

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? `erreur sans code : ${(error as Error).message}`;
  }
}

describe('clés OpenPGP (docs/03 §5, docs/02 §3.3, SEC-06)', () => {
  it('RSA 4096 en clé v4 (lue par gpgv des clients Debian 12), empreinte de 40 caractères hexadécimaux', async () => {
    const key = await openpgp.readPrivateKey({ armoredKey: rsa.privateKey });
    expect(key.keyPacket.version).toBe(4);
    expect(key.getAlgorithmInfo()).toEqual({ algorithm: 'rsaEncryptSign', bits: 4096 });
    expect(rsa.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(rsa.fingerprint).toBe(key.getFingerprint());
    expect(rsa.publicKey).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----');
    expect(rsa.publicKey).not.toContain('PRIVATE');
  });

  it('une seule sous-clé, de signature (RSA 4096), aucune sous-clé de chiffrement ; expiration à 2 ans', async () => {
    const key = await openpgp.readKey({ armoredKey: rsa.publicKey });
    expect(key.subkeys).toHaveLength(1);
    const [subkey] = key.subkeys;
    expect(subkey?.getAlgorithmInfo()).toEqual({ algorithm: 'rsaEncryptSign', bits: 4096 });
    expect(subkey?.bindingSignatures[0]?.keyFlags).toEqual([openpgp.enums.keyFlags.signData]);
    expect(await key.getExpirationTime()).toEqual(new Date(DATE.getTime() + 730 * DAY));
  });

  it('les signatures sont émises par la sous-clé, pas par la clé primaire', async () => {
    const signed = await clearsign(rsa.privateKey, RELEASE, DATE);
    const message = await openpgp.readCleartextMessage({ cleartextMessage: signed });
    const key = await openpgp.readKey({ armoredKey: rsa.publicKey });
    expect(message.getSigningKeyIDs().map((id) => id.toHex())).toEqual([key.subkeys[0]?.getKeyID().toHex()]);
  });

  it('refuse une date de création invalide', async () => {
    const request = { name: 'x', type: 'ed25519' as const, date: new Date(Number.NaN), validityDays: 1 };
    expect(await codeOf(() => generateOpenPgpKey(request))).toBe('OPENPGP_KEY_REQUEST_INVALID');
  });

  it('refuse une durée de validité nulle, négative ou démesurée', async () => {
    for (const validityDays of [0, -1, 1.5, 3651, Number.NaN]) {
      const request = { name: 'x', type: 'ed25519' as const, date: DATE, validityDays };
      expect(await codeOf(() => generateOpenPgpKey(request)), String(validityDays)).toBe('OPENPGP_KEY_REQUEST_INVALID');
    }
  });

  it("lit le type d'une clé publique (rotation à l'identique), refuse une clé illisible", async () => {
    expect(await openPgpKeyType(rsa.publicKey)).toBe('rsa4096');
    expect(await openPgpKeyType(ed.publicKey)).toBe('ed25519');
    expect(await codeOf(() => openPgpKeyType('pas une clé'))).toBe('OPENPGP_KEY_INVALID');
  });

  it('certificat de révocation généré avec la clé, qui révoque bien la clé publique', async () => {
    const publicKey = await openpgp.readKey({ armoredKey: rsa.publicKey });
    expect(await publicKey.isRevoked()).toBe(false);
    const { publicKey: revoked } = await openpgp.revokeKey({
      key: publicKey,
      revocationCertificate: rsa.revocationCertificate,
      format: 'object',
    });
    expect(await revoked.isRevoked()).toBe(true);
  });
});

describe('signatures OpenPGP', () => {
  it('clearsign (InRelease) : vérifiable, rend le texte signé, hachage SHA-256 au moins', async () => {
    const signed = await clearsign(rsa.privateKey, RELEASE, DATE);
    expect(signed.startsWith('-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n')).toBe(true);
    expect(await verifyClearsigned(rsa.publicKey, signed, DATE)).toBe(RELEASE);
  });

  it('signature détachée en armure (Release.gpg, repomd.xml.asc) : vérifiable', async () => {
    const signature = await detachSign(rsa.privateKey, DATA, DATE);
    expect(signature.startsWith('-----BEGIN PGP SIGNATURE-----')).toBe(true);
    await expect(verifyDetached(rsa.publicKey, DATA, signature, DATE)).resolves.toBeUndefined();
  });

  it('Ed25519 : signe et vérifie, en clair comme en détaché', async () => {
    expect(await verifyClearsigned(ed.publicKey, await clearsign(ed.privateKey, RELEASE, DATE), DATE)).toBe(RELEASE);
    await expect(verifyDetached(ed.publicKey, DATA, await detachSign(ed.privateKey, DATA, DATE), DATE)).resolves.toBe(
      undefined,
    );
  });

  it("refuse un texte modifié, une autre clé, une signature détachée sur d'autres octets", async () => {
    const signed = await clearsign(rsa.privateKey, RELEASE, DATE);
    const tampered = signed.replace('Suite: stable', 'Suite: unstable');
    expect(await codeOf(() => verifyClearsigned(rsa.publicKey, tampered, DATE))).toBe('OPENPGP_SIGNATURE_INVALID');
    expect(await codeOf(() => verifyClearsigned(ed.publicKey, signed, DATE))).toBe('OPENPGP_SIGNATURE_INVALID');

    const signature = await detachSign(rsa.privateKey, DATA, DATE);
    const changed = new TextEncoder().encode(`${RELEASE}x`);
    expect(await codeOf(() => verifyDetached(rsa.publicKey, changed, signature, DATE))).toBe(
      'OPENPGP_SIGNATURE_INVALID',
    );
    expect(await codeOf(() => verifyDetached(ed.publicKey, DATA, signature, DATE))).toBe('OPENPGP_SIGNATURE_INVALID');
  });

  it('refuse une clé expirée maintenant, même pour une signature datée de sa période de validité', async () => {
    const signed = await clearsign(expired.privateKey, RELEASE, DATE);
    const signature = await detachSign(expired.privateKey, DATA, DATE);
    expect(await verifyClearsigned(expired.publicKey, signed, DATE)).toBe(RELEASE);
    expect(await codeOf(() => verifyClearsigned(expired.publicKey, signed, LATER))).toBe('OPENPGP_SIGNATURE_INVALID');
    expect(await codeOf(() => verifyDetached(expired.publicKey, DATA, signature, LATER))).toBe(
      'OPENPGP_SIGNATURE_INVALID',
    );
  });

  it('refuse une clé révoquée', async () => {
    const signed = await clearsign(ed.privateKey, RELEASE, DATE);
    const { publicKey: revoked } = await openpgp.revokeKey({
      key: await openpgp.readKey({ armoredKey: ed.publicKey }),
      revocationCertificate: ed.revocationCertificate,
      format: 'armored',
    });
    expect(await codeOf(() => verifyClearsigned(revoked, signed, DATE))).toBe('OPENPGP_SIGNATURE_INVALID');
  });

  it('trousseau de plusieurs clés (rotation) : la signature de la seconde clé est acceptée', async () => {
    const keyring = `${rsa.publicKey}\n${ed.publicKey}`;
    expect(await verifyClearsigned(keyring, await clearsign(ed.privateKey, RELEASE, DATE), DATE)).toBe(RELEASE);
  });

  it("signatures multiples : acceptées si l'une vient d'une clé attendue et valide", async () => {
    const signingKeys = await Promise.all(
      [rsa.privateKey, ed.privateKey].map((armoredKey) => openpgp.readPrivateKey({ armoredKey })),
    );
    const message = await openpgp.createCleartextMessage({ text: RELEASE });
    const signed = await openpgp.sign({ message, signingKeys, date: DATE, format: 'armored' });
    expect(await verifyClearsigned(rsa.publicKey, signed, DATE)).toBe(RELEASE);
  });

  it("refuse tout texte placé hors de l'armure du message signé", async () => {
    const signed = await clearsign(rsa.privateKey, RELEASE, DATE);
    const other = await clearsign(rsa.privateKey, 'Origin: autre\n', DATE);
    const end = '-----END PGP SIGNATURE-----\n';
    for (const wrapped of [
      `Origin: evil\n\n${signed}`,
      `${signed}\nTrailing: evil\n`,
      `${signed}Origin: evil\n${other}`,
      `${signed}${other}`,
      `${signed}evil\n${end}`,
    ]) {
      expect(await codeOf(() => verifyClearsigned(rsa.publicKey, wrapped, DATE))).toBe('OPENPGP_SIGNATURE_INVALID');
    }
    expect(await verifyClearsigned(rsa.publicKey, `${signed.trimEnd()}\n`, DATE)).toBe(RELEASE);
  });

  it('refuse un texte non signé, une signature illisible ou une clé illisible avec des codes typés', async () => {
    expect(await codeOf(() => verifyClearsigned(rsa.publicKey, RELEASE, DATE))).toBe('OPENPGP_SIGNATURE_INVALID');
    expect(await codeOf(() => verifyDetached(rsa.publicKey, DATA, 'pas une signature', DATE))).toBe(
      'OPENPGP_SIGNATURE_INVALID',
    );
    expect(await codeOf(() => clearsign('pas une clé', RELEASE, DATE))).toBe('OPENPGP_KEY_INVALID');
    expect(await codeOf(() => clearsign(rsa.publicKey, RELEASE, DATE))).toBe('OPENPGP_KEY_INVALID');
    expect(await codeOf(() => verifyClearsigned('pas une clé', RELEASE, DATE))).toBe('OPENPGP_KEY_INVALID');
  });

  it('une signature impossible (date antérieure à la clé) lève un code typé', async () => {
    const before = new Date(DATE.getTime() - DAY);
    expect(await codeOf(() => clearsign(rsa.privateKey, RELEASE, before))).toBe('OPENPGP_SIGN_FAILED');
    expect(await codeOf(() => detachSign(rsa.privateKey, DATA, before))).toBe('OPENPGP_SIGN_FAILED');
  });

  it('refuse une clé privée chiffrée par phrase de passe (les clés sont protégées par seal, pas par OpenPGP)', async () => {
    const { privateKey } = await openpgp.generateKey({
      type: 'ecc',
      curve: 'ed25519Legacy',
      userIDs: [{ name: 'x' }],
      passphrase: 'phrase',
      format: 'armored',
    });
    expect(await codeOf(() => clearsign(privateKey, RELEASE, DATE))).toBe('OPENPGP_KEY_INVALID');
  });
});
