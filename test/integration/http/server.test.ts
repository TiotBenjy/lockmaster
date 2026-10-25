import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../../src/http/server.js';
import { testConfig, testDeps } from '../../helpers/deps.js';

// CSP d'ADR-0004 (amendée par ADR-0011 : font-src 'self'), à l'identique.
const ADR_0004_CSP =
  "default-src 'none';script-src 'self';style-src 'self';font-src 'self';img-src 'self' data:;" +
  "connect-src 'self';form-action 'self';frame-ancestors 'none';base-uri 'none'";

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function server(options: Parameters<typeof buildServer>[1] = {}) {
  const deps = testDeps();
  const app = await buildServer(deps, options);
  servers.push(app);
  return { app, deps };
}

describe('serveur HTTP : sondes', () => {
  it('/healthz répond « ok » sans détail interne', async () => {
    const { app } = await server();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok');
  });

  it('/readyz répond « ready » quand toutes les vérifications passent, 503 sinon', async () => {
    const ready = await server({ readinessChecks: [() => true] });
    expect((await ready.app.inject({ method: 'GET', url: '/readyz' })).body).toBe('ready');

    const notReady = await server({ readinessChecks: [() => true, () => false] });
    const res = await notReady.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('not ready');
  });

  it('/readyz est en échec si une vérification lève une exception', async () => {
    const { app } = await server({
      readinessChecks: [
        () => {
          throw new Error('base fermée');
        },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('base');
  });
});

describe('serveur HTTP : en-têtes de sécurité (docs/02 §3.6)', () => {
  it.each(['/healthz', '/absente'])('présents sur %s', async (url) => {
    const { app } = await server();
    const res = await app.inject({ method: 'GET', url });
    expect(res.headers['content-security-policy']).toBe(ADR_0004_CSP);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('envoie HSTS quand public_url est en https, pas en http', async () => {
    const https = await server();
    const res = await https.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');

    const plain = await buildServer(testDeps(testConfig({ server: { public_url: 'http://127.0.0.1:8080' } })));
    servers.push(plain);
    expect(
      (await plain.inject({ method: 'GET', url: '/healthz' })).headers['strict-transport-security'],
    ).toBeUndefined();
  });

  it("n'active pas CORS", async () => {
    const { app } = await server();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/healthz',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('serveur HTTP : erreurs sans fuite', () => {
  it('404 au format { error: { code, message, requestId } }', async () => {
    const { app } = await server();
    const res = await app.inject({ method: 'GET', url: '/apt/debian/dists/stable/InRelease' });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string; message: string; requestId: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('une erreur inattendue renvoie un message générique, sans pile ni détail, et est journalisée', async () => {
    const { app, deps } = await server({
      register: (instance) => {
        instance.get('/boom', { config: { public: true } }, async () => {
          throw new Error('échec dans /etc/lockmaster/secret.toml');
        });
      },
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL', message: 'erreur interne', requestId: res.headers['x-request-id'] },
    });
    expect(res.body).not.toContain('/etc/lockmaster');
    expect(deps.logs.text()).toContain('http.error');
  });

  it("ignore l'identifiant de requête fourni par le client", async () => {
    const { app } = await server();
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'forge' } });
    expect(res.headers['x-request-id']).not.toBe('forge');
    expect(String(res.headers['x-request-id'])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuse un corps trop gros avec 413', async () => {
    const { app } = await server({
      register: (instance) => {
        instance.post('/echo', { config: { public: true } }, async () => 'ok');
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect((res.json() as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('serveur HTTP : erreurs du framework et codes hors plage', () => {
  it('une URL mal encodée renvoie le format commun, sans la refléter, avec les en-têtes de sécurité', async () => {
    const { app } = await server();
    const res = await app.inject({ method: 'GET', url: '/%zz<script>' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: { code: 'VALIDATION', message: 'requête invalide', requestId: res.headers['x-request-id'] },
    });
    expect(res.body).not.toContain('script');
    expect(res.headers['content-security-policy']).toBe(ADR_0004_CSP);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it.each([200, 302, 600])('une erreur levée avec statusCode %i devient 500 INTERNAL', async (statusCode) => {
    const { app } = await server({
      register: (instance) => {
        instance.get('/odd', { config: { public: true } }, async () => {
          throw Object.assign(new Error('étrange'), { statusCode });
        });
      },
    });
    const res = await app.inject({ method: 'GET', url: '/odd' });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INTERNAL');
  });

  it('ne journalise pas la chaîne de requête (jetons, codes OIDC)', async () => {
    const { app, deps } = await server();
    await app.inject({ method: 'GET', url: '/healthz?token=valeur-secrete' });
    expect(deps.logs.text()).toContain('/healthz');
    expect(deps.logs.text()).not.toContain('valeur-secrete');
  });
});

describe('serveur HTTP : autorisation appliquée à chaque requête (invariant 7)', () => {
  it('une route déclarée avec une permission répond 401 sans identifiants', async () => {
    const { app } = await server({
      register: (instance) => {
        instance.get('/api/v1/system/status', { config: { perm: 'system:read' } }, async () => 'SECRET');
        instance.post(
          '/api/v1/repos/:repo/packages',
          { config: { perm: 'pkg:upload', repoParam: 'repo' } },
          async () => 'ok',
        );
      },
    });
    for (const [method, url] of [
      ['GET', '/api/v1/system/status'],
      ['HEAD', '/api/v1/system/status'],
      ['POST', '/api/v1/repos/debian/packages'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain('SECRET');
    }
  });
});

describe('serveur HTTP : limites (docs/01 §4)', () => {
  it('borne le nombre de connexions et le délai de réception des en-têtes', async () => {
    const { app } = await server();
    expect(app.server.maxConnections).toBe(1024);
    expect(app.server.headersTimeout).toBe(30_000);
    expect(app.server.requestTimeout).toBe(900_000);
  });
});

describe('serveur HTTP : autorisation déclarée (invariant 7)', () => {
  it('refuse de démarrer si une route ne déclare ni permission ni accès public', async () => {
    const deps = testDeps();
    await expect(
      buildServer(deps, {
        register: (instance) => {
          instance.get('/oubliee', async () => 'ok');
        },
      }),
    ).rejects.toThrow(/GET \/oubliee/);
  });

  it('les routes HEAD générées automatiquement héritent de la déclaration', async () => {
    const { app } = await server();
    const res = await app.inject({ method: 'HEAD', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});
