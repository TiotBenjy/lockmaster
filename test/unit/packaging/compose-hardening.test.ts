import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Complète test/security/SEC-14-compose-isolation.test.ts : ce test analyse les montages en syntaxe
// courte seulement, donc toute autre forme de montage ou de partage d'espace de noms est refusée ici ;
// clamd n'est joignable que par son socket Unix (SEC-14) ; mêmes règles pour les quadlets.

const ROOT = join(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const code = (path: string) =>
  read(path)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
const compose = code('deploy/compose.yaml');
const quadlet = (file: string) => code(`deploy/quadlet/lockmaster/${file}`);

function block(name: string): string {
  return new RegExp(`^ {2}${name}:.*\\n((?: {4}.*\\n|\\s*\\n)+)`, 'm').exec(compose)?.[1] ?? '';
}

describe('compose : formes non vérifiées interdites', () => {
  it.each([
    ['volumes_from', /^\s*volumes_from:/m],
    ['montage en syntaxe longue', /^\s*- type:/m],
    ['secrets ou configs', /^\s*(secrets|configs):/m],
    ['privileged', /^\s*privileged:/m],
    ['pid ou ipc partagés', /^\s*(pid|ipc):/m],
    ['cap_add', /^\s*cap_add:/m],
    ['devices', /^\s*devices:/m],
    ['réseau d un autre service', /network_mode: *"?(service|container):/m],
  ])('%s', (_label, pattern) => {
    expect(compose).not.toMatch(pattern);
  });
});

describe('clamd joignable seulement par son socket (SEC-14)', () => {
  it('compose : adresse unix:// et aucun port publié pour clamav', () => {
    expect(block('lockmaster')).toMatch(/^ {6}LOCKMASTER__SCANNERS__CLAMAV__ADDRESS: unix:\/\//m);
    expect(block('clamav')).not.toMatch(/^ {4}ports:/m);
  });

  it('quadlets : réseau scan interne, clamav sans port publié ni autre réseau', () => {
    expect(quadlet('lockmaster.network')).toMatch(/^Internal=true$/m);
    const clamav = quadlet('clamav.container');
    expect(clamav).not.toMatch(/^PublishPort=/m);
    expect([...clamav.matchAll(/^Network=(\S+)$/gm)].map(([, network]) => network)).toEqual(['lockmaster.network']);
  });
});

describe('quadlet repo (ADR-0008)', () => {
  const repo = quadlet('repo.container');

  it("seul sur son réseau, sans route vers l'application ni clamav", () => {
    expect([...repo.matchAll(/^Network=(\S+)$/gm)].map(([, network]) => network)).toEqual(['repo.network']);
  });

  it('ne monte que les fichiers publiés (lecture seule), sa configuration et son certificat', () => {
    expect([...repo.matchAll(/^Volume=(\S+)$/gm)].map(([, volume]) => volume)).toEqual([
      'repo-public.volume:/srv/lockmaster-repo:ro',
      '%h/nginx/lockmaster-repo.container.conf:/etc/nginx/conf.d/default.conf:ro,z',
      '%h/nginx/tls:/etc/nginx/tls:ro,z',
    ]);
  });
});
