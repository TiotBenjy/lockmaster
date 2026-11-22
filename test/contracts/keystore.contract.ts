import { describe, expect, it } from 'vitest';
import type { KeyStore, NewKey } from '../../src/signer/keystore.js';

const repoKey = (overrides: Partial<NewKey> = {}): NewKey => ({
  id: '01JKEY0000000000000000REPO',
  kind: 'openpgp',
  purpose: 'repo',
  fingerprint: 'a'.repeat(40),
  publicKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----\npublique\n-----END PGP PUBLIC KEY BLOCK-----\n',
  privateKey: '-----BEGIN PGP PRIVATE KEY BLOCK-----\nsecrète\n-----END PGP PRIVATE KEY BLOCK-----\n',
  identity: { repoName: 'debian-12', repoFormat: 'deb', originLabel: 'lockmaster-debian-12', allowedNames: ['*'] },
  state: 'active',
  createdAt: 1_800_000_000_000,
  expiresAt: 1_863_072_000_000,
  ...overrides,
});

const auditKey = (): NewKey =>
  repoKey({ id: '01JKEY000000000000000AUDIT', purpose: 'audit', identity: null, fingerprint: 'b'.repeat(40) });

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? `erreur sans code : ${(error as Error).message}`;
  }
}

/** Suite de conformité de `KeyStore` : stockage SQLite du signataire et faux en mémoire. */
export function describeKeyStoreContract(make: () => KeyStore): void {
  describe('contrat KeyStore', () => {
    it("rend la partie publique et l'identité, jamais la clé privée", () => {
      const store = make();
      const { privateKey, ...expected } = repoKey();
      store.insert(repoKey());
      expect(store.get(expected.id)).toEqual(expected);
      expect(store.list()).toEqual([expected]);
      expect(JSON.stringify(store.list())).not.toContain('secrète');
      expect(privateKey).toContain('secrète');
    });

    it('déchiffre la clé privée pour signer', () => {
      const store = make();
      store.insert(repoKey());
      expect(store.privateKey(repoKey().id)).toBe(repoKey().privateKey);
    });

    it("clé d'audit sans identité ; clé de dépôt avec identité obligatoire", () => {
      const store = make();
      store.insert(auditKey());
      expect(store.get(auditKey().id)?.identity).toBeNull();
      expect(codeOf(() => store.insert(repoKey({ id: 'x1', fingerprint: 'c'.repeat(40), identity: null })))).toBe(
        'KEY_INVALID',
      );
      const audit = { ...auditKey(), id: 'x2', fingerprint: 'd'.repeat(40), identity: repoKey().identity };
      expect(codeOf(() => store.insert(audit))).toBe('KEY_INVALID');
    });

    it('refuse un identifiant ou une empreinte déjà présents', () => {
      const store = make();
      store.insert(repoKey());
      expect(codeOf(() => store.insert(repoKey({ fingerprint: 'e'.repeat(40) })))).toBe('KEY_EXISTS');
      expect(codeOf(() => store.insert(repoKey({ id: 'autre' })))).toBe('KEY_EXISTS');
    });

    it('clé inconnue : get rend undefined, privateKey et transition lèvent KEY_NOT_FOUND', () => {
      const store = make();
      expect(store.get('inconnue')).toBeUndefined();
      expect(codeOf(() => store.privateKey('inconnue'))).toBe('KEY_NOT_FOUND');
      expect(codeOf(() => store.transition('inconnue', ['active'], 'retired'))).toBe('KEY_NOT_FOUND');
    });

    it("change l'état seulement depuis un état attendu", () => {
      const store = make();
      store.insert(repoKey());
      store.transition(repoKey().id, ['active'], 'rotating_out');
      expect(store.get(repoKey().id)?.state).toBe('rotating_out');
      expect(codeOf(() => store.transition(repoKey().id, ['active'], 'retired'))).toBe('KEY_STATE_CONFLICT');
      expect(store.get(repoKey().id)?.state).toBe('rotating_out');
    });

    it('les objets rendus ne permettent pas de modifier la clé stockée', () => {
      const store = make();
      store.insert(repoKey());
      const record = store.get(repoKey().id);
      (record?.identity?.allowedNames as string[] | undefined)?.push('autre');
      expect(store.get(repoKey().id)?.identity?.allowedNames).toEqual(['*']);
    });

    it('une clé retirée ne se déchiffre plus, et retired est un état définitif', () => {
      const store = make();
      store.insert(repoKey());
      store.transition(repoKey().id, ['active'], 'retired');
      expect(codeOf(() => store.privateKey(repoKey().id))).toBe('KEY_RETIRED');
      expect(codeOf(() => store.transition(repoKey().id, ['retired'], 'active'))).toBe('KEY_STATE_CONFLICT');
      expect(store.get(repoKey().id)?.state).toBe('retired');
    });

    it.each([
      ['nom de dépôt invalide', { identity: { ...repoKey().identity, repoName: '../x' } }],
      ['Origin/Label vide', { identity: { ...repoKey().identity, originLabel: '' } }],
      ['Origin/Label avec un saut de ligne', { identity: { ...repoKey().identity, originLabel: 'a\nOrigin: b' } }],
      ['format inconnu', { identity: { ...repoKey().identity, repoFormat: 'zip' } }],
      ['motif de nom vide', { identity: { ...repoKey().identity, allowedNames: [''] } }],
      ['clé APK pour un dépôt deb', { kind: 'apk-rsa' }],
      ['clé OpenPGP pour un dépôt apk', { identity: { ...repoKey().identity, repoFormat: 'apk' } }],
      ['empreinte mal formée', { fingerprint: 'XYZ' }],
      ['identifiant mal formé', { id: 'a b' }],
    ])('refuse une clé mal formée (KEY_INVALID) : %s', (_label, change) => {
      const store = make();
      expect(codeOf(() => store.insert(repoKey(change as Partial<NewKey>)))).toBe('KEY_INVALID');
      expect(store.list()).toEqual([]);
    });
  });
}
