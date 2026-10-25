import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { schemaLeaves } from '../../../src/config/introspect.js';
import { configSchema } from '../../../src/config/schema.js';
import { REPO_ROOT } from '../../helpers/run-script.js';

const example = parseToml(readFileSync(join(REPO_ROOT, 'deploy/lockmaster.example.toml'), 'utf8'));

// Clés dont la valeur du fichier d'exemple est un EXEMPLE à adapter, pas une valeur par défaut.
const EXAMPLE_ONLY = [
  'server.public_url',
  'publish.targets',
  'auth.ldap.urls',
  'auth.ldap.ca_file',
  'auth.ldap.base_dn',
  'auth.ldap.bind_dn',
  'auth.ldap.bind_password_file',
];

const MINIMAL = {
  server: { public_url: 'https://lockmaster.example.com' },
  publish: { targets: [{ name: 'local', kind: 'local', path: '/srv/lockmaster-repo', public_url: 'https://repo' }] },
};

function flatten(value: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      for (const [k, v] of flatten(child, prefix ? `${prefix}.${key}` : key)) out.set(k, v);
    }
  } else {
    out.set(prefix, value);
  }
  return out;
}

describe('schéma de configuration = deploy/lockmaster.example.toml', () => {
  it("accepte le fichier d'exemple", () => {
    const result = configSchema.safeParse(example);
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it('documente exactement les clés du schéma, ni plus ni moins', () => {
    const documented = [...flatten(example).keys()].sort();
    const declared = [...schemaLeaves(configSchema).keys()].sort();
    expect(declared.length).toBeGreaterThan(75);
    expect(documented).toEqual(declared);
  });

  it("donne les valeurs par défaut écrites dans le fichier d'exemple", () => {
    const fromExample = flatten(configSchema.parse(example));
    const fromDefaults = flatten(configSchema.parse(MINIMAL));
    for (const key of EXAMPLE_ONLY) {
      fromExample.delete(key);
      fromDefaults.delete(key);
    }
    expect(Object.fromEntries(fromDefaults)).toEqual(Object.fromEntries(fromExample));
  });
});

describe('validation', () => {
  const withPatch = (patch: Record<string, unknown>) => configSchema.safeParse({ ...MINIMAL, ...patch });

  it.each([
    ['clé inconnue à la racine', { inconnue: 1 }],
    ['clé inconnue dans une section', { http: { listn: ':80' } }],
    ['durée invalide', { http: { request_timeout: '15 minutes' } }],
    ['adresse invalide', { http: { listen: '8080' } }],
    ['TLS incomplet', { http: { tls_cert_file: '/etc/cert.pem' } }],
    ['OIDC activé sans issuer', { auth: { oidc: { enabled: true, client_id: 'x', client_secret_file: '/s' } } }],
    [
      'OIDC en http',
      { auth: { oidc: { enabled: true, issuer: 'http://sso', client_id: 'x', client_secret_file: '/s' } } },
    ],
    ['LDAP activé incomplet', { auth: { ldap: { enabled: true } } }],
    ['Valid-Until au-delà de 30 jours', { publish: { ...MINIMAL.publish, valid_until_days: 31 } }],
    ['aucune cible', { publish: { targets: [] } }],
    ['cible de type inconnu', { publish: { targets: [{ name: 's3', kind: 's3', public_url: 'https://x' }] } }],
    ['noms de cibles en double', { publish: { targets: [MINIMAL.publish.targets[0], MINIMAL.publish.targets[0]] } }],
    ['URL de flux en http', { feeds: { kev_url: 'http://example.com/kev.json' } }],
    ['rôle MFA inconnu', { security: { mfa_required_roles: ['root'] } }],
    ['segment .. dans data_dir', { server: { ...MINIMAL.server, data_dir: '/var/lib/x/../lockmaster' } }],
    ['segment .. dans un chemin de fichier', { security: { master_key_file: '/etc/lockmaster/../master.key' } }],
  ])('refuse : %s', (_label, patch) => {
    expect(withPatch(patch).success).toBe(false);
  });

  it('convertit durées et adresses', () => {
    const config = configSchema.parse(MINIMAL);
    expect(config.http.request_timeout).toBe(900_000);
    expect(config.http.listen).toEqual({ host: '0.0.0.0', port: 8080 });
    expect(config.stats.syslog_listen).toBeNull();
  });
});
