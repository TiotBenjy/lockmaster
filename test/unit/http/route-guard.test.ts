import { describe, expect, it } from 'vitest';
import { LockmasterError } from '../../../src/domain/errors.js';
import { assertRouteDeclared } from '../../../src/http/route-guard.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof LockmasterError ? error.code : String(error);
  }
  return undefined;
}

describe('assertRouteDeclared (invariant 7)', () => {
  it.each([
    [{ url: '/healthz', method: 'GET', config: { public: true } }],
    [{ url: '/api/v1/repos', method: 'GET', config: { perm: 'repo:read' } }],
    [{ url: '/api/v1/repos/:repo/packages', method: 'POST', config: { perm: 'pkg:upload', repoParam: 'repo' } }],
    [{ url: '/api/v1/repos/:repo', method: 'DELETE', config: { perm: 'repo:manage', repoParam: 'repo' } }],
  ])('accepte une route déclarée : %j', (route) => {
    expect(() => assertRouteDeclared(route)).not.toThrow();
  });

  it.each([
    ['sans config', { url: '/x', method: 'GET' }],
    ['config vide', { url: '/x', method: 'GET', config: {} }],
    ['public: false', { url: '/x', method: 'GET', config: { public: false } }],
    ['public non booléen', { url: '/x', method: 'GET', config: { public: 'true' } }],
    ['permission vide', { url: '/x', method: 'GET', config: { perm: '' } }],
    ['permission mal formée', { url: '/x', method: 'GET', config: { perm: 'admin' } }],
    ['public et permission', { url: '/x', method: 'GET', config: { public: true, perm: 'repo:read' } }],
    ["repoParam absent de l'URL", { url: '/x/:id', method: 'GET', config: { perm: 'repo:read', repoParam: 'repo' } }],
    [
      "repoParam préfixe d'un autre paramètre",
      { url: '/repos/:repository/x', method: 'GET', config: { perm: 'repo:read', repoParam: 'repo' } },
    ],
    ['permission inconnue (faute de frappe)', { url: '/x', method: 'GET', config: { perm: 'pkg:uplaod' } }],
    [
      'repoParam sur une route publique',
      { url: '/x/:repo', method: 'GET', config: { public: true, repoParam: 'repo' } },
    ],
  ])('refuse une route %s', (_label, route) => {
    expect(codeOf(() => assertRouteDeclared(route))).toBe('ROUTE_WITHOUT_PERMISSION');
  });

  it("nomme la route fautive dans l'erreur", () => {
    expect(() => assertRouteDeclared({ url: '/oubliee', method: 'DELETE' })).toThrow(/DELETE \/oubliee/);
  });
});
