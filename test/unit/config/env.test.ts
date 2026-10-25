import { describe, expect, it } from 'vitest';
import { applyEnvOverrides } from '../../../src/config/env.js';
import { configSchema } from '../../../src/config/schema.js';
import { LockmasterError } from '../../../src/domain/errors.js';

const PREFIX = 'LOCKMASTER__';
const apply = (doc: Record<string, unknown>, env: Record<string, string>) =>
  applyEnvOverrides(doc, env, { prefix: PREFIX, schema: configSchema });

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof LockmasterError ? error.code : 'not-a-lockmaster-error';
  }
  return undefined;
}

describe('applyEnvOverrides', () => {
  it('surcharge une clé de chaque type, sans tenir compte de la casse', () => {
    const doc = apply(
      { http: { listen: ':8080' } },
      {
        LOCKMASTER__HTTP__LISTEN: ':8443',
        lockmaster__scanners__clamav__max_stream_bytes: '1073741824',
        LOCKMASTER__AUTH__OIDC__ENABLED: 'true',
        LOCKMASTER__SECURITY__MFA_REQUIRED_ROLES: '["admin"]',
        LOCKMASTER__LOG__LEVEL: 'debug',
      },
    );
    expect(doc).toEqual({
      http: { listen: ':8443' },
      scanners: { clamav: { max_stream_bytes: 1_073_741_824 } },
      auth: { oidc: { enabled: true } },
      security: { mfa_required_roles: ['admin'] },
      log: { level: 'debug' },
    });
  });

  it('garde une chaîne telle quelle même si elle ressemble à un nombre', () => {
    expect(apply({}, { LOCKMASTER__SMTP__USERNAME: '12345' })).toEqual({ smtp: { username: '12345' } });
  });

  it('ignore les variables sans le préfixe exact (LOCKMASTER_CONFIG, autre préfixe)', () => {
    expect(
      apply({}, { LOCKMASTER_CONFIG: '/etc/x.toml', LOCKMASTER_SIGNER__LOG__LEVEL: 'debug', PATH: '/bin' }),
    ).toEqual({});
  });

  it('ne modifie pas le document reçu', () => {
    const doc = { http: { listen: ':8080' } };
    apply(doc, { LOCKMASTER__HTTP__LISTEN: ':9000' });
    expect(doc.http.listen).toBe(':8080');
  });

  it.each([
    ['clé inconnue', { LOCKMASTER__HTTP__LISTN: ':80' }, 'CONFIG_UNKNOWN_ENV'],
    ['section inconnue', { LOCKMASTER__NOPE__X: '1' }, 'CONFIG_UNKNOWN_ENV'],
    ['section entière', { LOCKMASTER__HTTP: '{}' }, 'CONFIG_UNKNOWN_ENV'],
    ['séparateur vide', { LOCKMASTER____LISTEN: '1' }, 'CONFIG_UNKNOWN_ENV'],
    ['cibles de publication', { LOCKMASTER__PUBLISH__TARGETS: '[]' }, 'CONFIG_ENV_NOT_ALLOWED'],
    ['nombre invalide', { LOCKMASTER__HTTP__MAX_UPLOAD_BYTES: '2 GiB' }, 'CONFIG_INVALID_ENV'],
    ['booléen invalide', { LOCKMASTER__AUTH__OIDC__ENABLED: 'yes' }, 'CONFIG_INVALID_ENV'],
    ['JSON invalide', { LOCKMASTER__HTTP__TRUSTED_PROXIES: '[10.0.0.1' }, 'CONFIG_INVALID_ENV'],
  ])('refuse : %s', (_label, env, code) => {
    expect(errorCode(() => apply({}, env))).toBe(code);
  });

  it("refuse de traverser une valeur qui n'est pas une table", () => {
    expect(errorCode(() => apply({ http: 'texte' }, { LOCKMASTER__HTTP__LISTEN: ':1' }))).toBe('CONFIG_INVALID_ENV');
  });
});
