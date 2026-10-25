import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// SEC-14 et ADR-0009 : séparation du signataire et isolation réseau dans les déploiements conteneur,
// vérifiées sur les fichiers : un montage ou un réseau ajouté au mauvais service fait échouer la CI.

const ROOT = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const compose = read('deploy/compose.yaml');
const SERVICES = ['signer', 'lockmaster', 'clamav', 'repo'];

function block(name: string): string {
  const found = new RegExp(`^ {2}${name}:.*\\n((?: {4}.*\\n|\\s*\\n)+)`, 'm').exec(compose)?.[1];
  if (found === undefined) throw new Error(`service ${name} absent de compose.yaml`);
  return found;
}

/** Montages d'un service (« source:cible:options »), sans commentaires. */
function mounts(name: string): string[] {
  const list = /^ {4}volumes:\n((?: {6}- .*\n|\s*#.*\n)+)/m.exec(block(name))?.[1] ?? '';
  return [...list.matchAll(/^ {6}- ([^\s#]+)/gm)].map(([, mount]) => mount as string);
}

function networks(name: string): string[] {
  const inline = /^ {4}networks: \[([^\]]*)\]/m.exec(block(name))?.[1];
  return inline === undefined ? [] : inline.split(',').map((item) => item.trim());
}

const owners = (needle: string) => SERVICES.filter((name) => mounts(name).some((mount) => mount.includes(needle)));

describe('SEC-14 compose : séparation du signataire (ADR-0009)', () => {
  it('le volume et la clé maîtresse du signataire ne sont montés que dans signer', () => {
    expect(owners('signer-keys')).toEqual(['signer']);
    expect(owners('signer-master.key')).toEqual(['signer']);
  });

  it("la clé maîtresse de l'application n'est montée que dans lockmaster", () => {
    expect(owners('secrets/master.key')).toEqual(['lockmaster']);
  });

  it("le mot de passe admin initial n'est monté dans aucun service permanent (seulement par compose run init)", () => {
    expect(owners('admin_password')).toEqual([]);
  });

  it("le socket n'est partagé qu'entre signer et lockmaster", () => {
    expect(owners('sign-sock')).toEqual(['signer', 'lockmaster']);
  });

  it('repo ne monte que les fichiers publiés (lecture seule), sa configuration et son certificat', () => {
    expect(mounts('repo')).toEqual([
      'repo-public:/srv/lockmaster-repo:ro',
      './nginx/lockmaster-repo.container.conf:/etc/nginx/conf.d/default.conf:ro,z',
      './tls:/etc/nginx/tls:ro,z',
    ]);
  });
});

describe('SEC-14 compose : réseaux', () => {
  it("le signataire n'a aucun réseau", () => {
    expect(block('signer')).toMatch(/^ {4}network_mode: none/m);
    expect(networks('signer')).toEqual([]);
  });

  it('clamav et lockmaster seuls sur le réseau interne scan ; repo sans route vers eux', () => {
    expect(compose).toMatch(/^ {2}scan: +\{ internal: true \}/m);
    expect(networks('clamav')).toEqual(['scan']);
    expect(networks('lockmaster')).toEqual(['scan', 'egress']);
    expect(networks('repo')).toEqual(['repo']);
  });

  it("le port d'administration n'écoute que sur la boucle locale", () => {
    expect(block('lockmaster')).toMatch(/^ {4}ports: \["127\.0\.0\.1:8080:8080"\]/m);
  });
});

describe('SEC-14 quadlets : séparation par compte (ADR-0009)', () => {
  const signer = read('deploy/quadlet/lockmaster-signer/lockmaster-signer.container');
  const app = read('deploy/quadlet/lockmaster/lockmaster.container');

  it("le signataire n'a aucun réseau et ne monte que son volume et le dossier du socket", () => {
    expect(signer).toMatch(/^Network=none$/m);
    const volumes = [...signer.matchAll(/^Volume=(\S+)$/gm)].map(([, volume]) => volume);
    expect(volumes.sort()).toEqual([
      '/run/lockmaster-sign:/run/lockmaster-sign',
      'lockmaster-signer-keys.volume:/var/lib/lockmaster-signer',
    ]);
  });

  it('chaque clé maîtresse est un secret Podman lisible par le seul UID de son service', () => {
    expect(signer).toMatch(
      /^Secret=lockmaster-signer-master-key,type=mount,target=\/run\/secrets\/master_key,uid=10002,gid=10100,mode=0400$/m,
    );
    expect(app).toMatch(
      /^Secret=lockmaster-master-key,type=mount,target=\/run\/secrets\/master_key,uid=10001,gid=10101,mode=0400$/m,
    );
    expect(app).not.toMatch(/signer-keys|signer-master-key/);
  });
});
