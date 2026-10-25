import { z } from 'zod';
import {
  boundedInt,
  duration,
  fingerprint,
  httpUrl,
  ipOrCidr,
  listenAddress,
  optionalListenAddress,
  path,
  positiveInt,
  ROLES,
} from './fields.js';

// Schéma de lockmaster.toml. Référence documentée : deploy/lockmaster.example.toml (mêmes clés, mêmes
// défauts : vérifié par test/unit/config/schema.test.ts). Toute clé inconnue est une erreur (strict).

const required = (ctx: z.RefinementCtx, value: string | readonly unknown[], key: string, reason: string) => {
  if (value.length === 0) ctx.addIssue({ code: 'custom', path: [key], message: `obligatoire ${reason}` });
};

const server = z.strictObject({
  public_url: httpUrl({ httpsOnly: false }),
  data_dir: path('/var/lib/lockmaster'),
});

const http = z
  .strictObject({
    listen: listenAddress(':8080'),
    trusted_proxies: z.array(ipOrCidr).default([]),
    tls_cert_file: path(),
    tls_key_file: path(),
    acme_domains: z.array(z.string().min(1)).default([]),
    acme_email: z.string().default(''),
    max_upload_bytes: positiveInt(2_147_483_648),
    request_timeout: duration('15m'),
  })
  .superRefine((value, ctx) => {
    if ((value.tls_cert_file === '') !== (value.tls_key_file === '')) {
      ctx.addIssue({ code: 'custom', path: ['tls_key_file'], message: 'tls_cert_file et tls_key_file vont ensemble' });
    }
    if (value.acme_domains.length > 0 && value.tls_cert_file !== '') {
      ctx.addIssue({ code: 'custom', path: ['acme_domains'], message: 'ACME et tls_*_file sont exclusifs' });
    }
  });

const security = z.strictObject({
  master_key_file: path('/etc/lockmaster/master.key'),
  session_idle_timeout: duration('30m'),
  session_max_lifetime: duration('12h'),
  login_max_failures: positiveInt(5),
  login_lockout: duration('15m'),
  login_rate_per_minute: positiveInt(10),
  mfa_required_roles: z.array(z.enum(ROLES)).default(['admin', 'maintainer']),
});

const oidc = z
  .strictObject({
    enabled: z.boolean().default(false),
    issuer: z.string().default(''),
    client_id: z.string().default(''),
    client_secret_file: path(),
    scopes: z.array(z.string().min(1)).default(['openid', 'profile', 'email', 'groups']),
    groups_claim: z.string().min(1).default('groups'),
    mfa: z.enum(['idp', 'app']).default('idp'),
    mfa_amr: z.array(z.string().min(1)).default(['mfa', 'otp', 'hwk', 'swk', 'sc']),
    mfa_acr: z.array(z.string().min(1)).default([]),
    mfa_max_age: duration('12h'),
  })
  .superRefine((value, ctx) => {
    if (!value.enabled) return;
    if (!httpUrl({ httpsOnly: true }).safeParse(value.issuer).success) {
      ctx.addIssue({ code: 'custom', path: ['issuer'], message: 'URL https:// obligatoire quand OIDC est activé' });
    }
    required(ctx, value.client_id, 'client_id', 'quand OIDC est activé');
    required(ctx, value.client_secret_file, 'client_secret_file', 'quand OIDC est activé');
  });

const ldap = z
  .strictObject({
    enabled: z.boolean().default(false),
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
      .default('ad'),
    urls: z.array(z.string().regex(/^ldaps?:\/\/[^\s/]+$/, 'URL ldaps://hôte:port attendue')).default([]),
    starttls: z.boolean().default(false),
    ca_file: path(),
    base_dn: z.string().default(''),
    user_filter: z.string().default('(&(objectClass=user)(sAMAccountName={username}))'),
    bind_dn: z.string().default(''),
    bind_password_file: path(),
    timeout: duration('10s'),
  })
  .superRefine((value, ctx) => {
    if (!value.enabled) return;
    const why = 'quand LDAP est activé';
    for (const key of ['urls', 'ca_file', 'base_dn', 'bind_dn', 'bind_password_file'] as const) {
      required(ctx, value[key], key, why);
    }
    if (!value.user_filter.includes('{username}')) {
      ctx.addIssue({ code: 'custom', path: ['user_filter'], message: 'doit contenir {username}' });
    }
    // TLS obligatoire : ldap:// seulement avec STARTTLS.
    if (value.urls.some((url) => url.startsWith('ldap://')) && !value.starttls) {
      ctx.addIssue({ code: 'custom', path: ['urls'], message: 'ldap:// exige starttls = true (TLS obligatoire)' });
    }
  });

const directory = z.strictObject({
  sync_interval: duration('1h'),
  max_staleness: duration('72h'),
  disable_local_login: z.boolean().default(false),
});

const targetName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'nom de cible : minuscules, chiffres et tirets');

const localTarget = z.strictObject({
  name: targetName,
  kind: z.literal('local'),
  path: path().refine((value) => value !== '', 'chemin obligatoire'),
  public_url: httpUrl({ httpsOnly: false }),
  verify: z.boolean().default(true),
  hardlink: z.boolean().default(true),
});

const rsyncTarget = z.strictObject({
  name: targetName,
  kind: z.literal('rsync'),
  destination: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}@[A-Za-z0-9.-]+$/, 'destination utilisateur@hôte attendue'),
  port: boundedInt(1, 65_535, 22),
  ssh_key_file: path().refine((value) => value !== '', 'clé SSH obligatoire'),
  known_hosts_file: path().refine((value) => value !== '', 'known_hosts épinglé obligatoire'),
  rsync_binary: path('/usr/bin/rsync'),
  public_url: httpUrl({ httpsOnly: false }),
  verify: z.boolean().default(true),
});

const publish = z.strictObject({
  generations_kept: boundedInt(1, 100, 5),
  // Le signataire refuse un Valid-Until au-delà de 30 jours (ADR-0009).
  valid_until_days: boundedInt(1, 30, 7),
  verify_interval: duration('15m'),
  targets: z
    .array(z.discriminatedUnion('kind', [localTarget, rsyncTarget]))
    .min(1, 'au moins une cible de publication')
    .refine((targets) => new Set(targets.map((t) => t.name)).size === targets.length, 'noms de cibles en double'),
});

const clamav = z.strictObject({
  address: z
    .string()
    .regex(/^(unix:\/\/\/[^\0]+|tcp:\/\/[A-Za-z0-9.:[\]-]+:[0-9]{1,5})$/, 'unix:///chemin ou tcp://hôte:port attendu')
    .default('unix:///run/clamav/clamd.sock'),
  canary_interval: duration('15m'),
  timeout: duration('120s'),
  max_stream_bytes: positiveInt(2_147_483_648),
  max_signature_age: duration('48h'),
});

const grype = z.strictObject({
  binary: path('/usr/lib/lockmaster/bin/grype'),
  db_dir: path('/var/lib/lockmaster/vulndb'),
  timeout: duration('300s'),
  max_db_age: duration('5d'),
  auto_update: z.boolean().default(true),
});

const feeds = z.strictObject({
  offline: z.boolean().default(false),
  trusted_bundle_keys: z.array(fingerprint).default([]),
  kev_url: httpUrl({ httpsOnly: true }).default(
    'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
  ),
  epss_url: httpUrl({ httpsOnly: true }).default('https://epss.empiricalsecurity.com/epss_scores-current.csv.gz'),
});

const smtp = z
  .strictObject({
    enabled: z.boolean().default(false),
    host: z.string().default(''),
    port: boundedInt(1, 65_535, 587),
    starttls: z.boolean().default(true),
    username: z.string().default(''),
    password_file: path(),
    from: z.string().default(''),
  })
  .superRefine((value, ctx) => {
    if (!value.enabled) return;
    required(ctx, value.host, 'host', 'quand SMTP est activé');
    required(ctx, value.from, 'from', 'quand SMTP est activé');
  });

const stats = z.strictObject({
  syslog_listen: optionalListenAddress(),
  allowed_sources: z.array(ipOrCidr).default([]),
});

const limits = z.strictObject({
  uploads_concurrent_per_principal: positiveInt(4),
  upload_bytes_per_principal_per_day: positiveInt(53_687_091_200),
  min_free_disk_bytes: positiveInt(10_737_418_240),
  scrypt_queue_max: positiveInt(32),
  zstd_window_log_max: boundedInt(10, 31, 27),
  xz_memory_limit_bytes: positiveInt(268_435_456),
  fts_query_max_length: boundedInt(1, 1024, 128),
});

const log = z.strictObject({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  format: z.enum(['json', 'pretty']).default('json'),
});

const metrics = z.strictObject({
  enabled: z.boolean().default(true),
  listen_metrics: listenAddress('127.0.0.1:9090'),
  token_file: path(),
});

/** Schéma complet ; une section absente prend ses valeurs par défaut (prefault). */
export const configSchema = z.strictObject({
  server,
  http: http.prefault({}),
  security: security.prefault({}),
  auth: z
    .strictObject({ oidc: oidc.prefault({}), ldap: ldap.prefault({}), directory: directory.prefault({}) })
    .prefault({}),
  signer: z.strictObject({ socket: path('/run/lockmaster-sign/sign.sock'), timeout: duration('30s') }).prefault({}),
  publish,
  scanners: z.strictObject({ clamav: clamav.prefault({}), grype: grype.prefault({}) }).prefault({}),
  feeds: feeds.prefault({}),
  smtp: smtp.prefault({}),
  stats: stats.prefault({}),
  limits: limits.prefault({}),
  log: log.prefault({}),
  metrics: metrics.prefault({}),
});

export type Config = z.output<typeof configSchema>;
export type PublishTarget = Config['publish']['targets'][number];
