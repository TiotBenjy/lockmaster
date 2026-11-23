import {
  createHash,
  createPublicKey,
  createVerify,
  generateKeyPairSync,
  type KeyPairKeyObjectResult,
} from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type ApkRsaKey,
  apkKeyFingerprint,
  generateApkRsaKey,
  signApk,
  verifyApk,
} from '../../../src/crypto/apk-rsa.js';

let key: ApkRsaKey;
let other: ApkRsaKey;
beforeAll(async () => {
  [key, other] = await Promise.all([generateApkRsaKey(), generateApkRsaKey()]);
}, 60_000);

const DATA = new TextEncoder().encode("segment de contrôle gzip de l'APKINDEX");

describe('signature RSA APK (docs/02 §3.3, docs/03 §4.3)', () => {
  it('clé RSA 4096, publique en PEM SPKI, privée en PEM PKCS#8', () => {
    const publicKey = createPublicKey(key.publicKeyPem);
    expect(publicKey.asymmetricKeyType).toBe('rsa');
    expect(publicKey.asymmetricKeyDetails?.modulusLength).toBe(4096);
    expect(key.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true);
    expect(key.privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
  });

  it('empreinte : SHA-256 de la clé publique en SPKI DER, 64 caractères hexadécimaux', () => {
    const der = createPublicKey(key.publicKeyPem).export({ type: 'spki', format: 'der' });
    expect(apkKeyFingerprint(key.publicKeyPem)).toBe(createHash('sha256').update(der).digest('hex'));
    expect(apkKeyFingerprint(key.publicKeyPem)).not.toBe(apkKeyFingerprint(other.publicKeyPem));
    expect(() => apkKeyFingerprint('pas une clé')).toThrow(expect.objectContaining({ code: 'APK_KEY_INVALID' }));
  });

  it('signe en PKCS#1 v1.5 SHA-256 (format .SIGN.RSA256), vérifiable par openssl comme par verifyApk', () => {
    const signature = signApk(key.privateKeyPem, DATA);
    expect(signature).toHaveLength(512);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(DATA);
    expect(verifier.verify(key.publicKeyPem, signature)).toBe(true);
    expect(verifyApk(key.publicKeyPem, DATA, signature)).toBe(true);
  });

  it('refuse des données modifiées, une autre clé, une signature tronquée', () => {
    const signature = signApk(key.privateKeyPem, DATA);
    expect(verifyApk(key.publicKeyPem, new TextEncoder().encode('autre'), signature)).toBe(false);
    expect(verifyApk(other.publicKeyPem, DATA, signature)).toBe(false);
    expect(verifyApk(key.publicKeyPem, DATA, signature.subarray(1))).toBe(false);
  });

  it('refuse une clé illisible ou trop courte avec un code typé', () => {
    expect(() => signApk('pas une clé', DATA)).toThrow(expect.objectContaining({ code: 'APK_KEY_INVALID' }));
    expect(() => signApk(key.publicKeyPem, DATA)).toThrow(expect.objectContaining({ code: 'APK_KEY_INVALID' }));
    expect(() => verifyApk('pas une clé', DATA, Buffer.alloc(512))).toThrow(
      expect.objectContaining({ code: 'APK_KEY_INVALID' }),
    );
  });

  it('refuse une clé RSA de moins de 2048 bits, une clé EC ou RSA-PSS (APK_KEY_INVALID)', () => {
    const pemOf = ({ privateKey, publicKey }: KeyPairKeyObjectResult) => ({
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    const keys = [
      pemOf(generateKeyPairSync('rsa', { modulusLength: 1024 })),
      pemOf(generateKeyPairSync('ec', { namedCurve: 'P-256' })),
      pemOf(generateKeyPairSync('rsa-pss', { modulusLength: 2048 })),
    ];
    for (const { privateKey, publicKey } of keys) {
      expect(() => signApk(privateKey, DATA)).toThrow(expect.objectContaining({ code: 'APK_KEY_INVALID' }));
      expect(() => verifyApk(publicKey, DATA, Buffer.alloc(256))).toThrow(
        expect.objectContaining({ code: 'APK_KEY_INVALID' }),
      );
    }
  });
});
