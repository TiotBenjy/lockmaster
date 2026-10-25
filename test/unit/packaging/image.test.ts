import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Règles de l'image OCI (ADR-0007, ADR-0013) et des déploiements conteneur (compose, quadlets),
// vérifiées sur les fichiers. Le démarrage réel (Docker et Podman) est testé par test/deliverables/.

const ROOT = join(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const containerfile = read('packaging/Containerfile');
const compose = read('deploy/compose.yaml');
const quadlets = ['deploy/quadlet/lockmaster', 'deploy/quadlet/lockmaster-signer'].flatMap((dir) =>
  readdirSync(join(ROOT, dir)).map((file) => `${dir}/${file}`),
);

function versionsEnv(): Map<string, string> {
  return new Map(
    read('packaging/versions.env')
      .split('\n')
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => line.split('=', 2) as [string, string]),
  );
}

/** Bloc YAML d'un service de compose (lignes indentées sous `  <nom>:`). */
function service(name: string): string {
  return new RegExp(`^ {2}${name}:.*\\n((?: {4}.*\\n|\\s*\\n)+)`, 'm').exec(compose)?.[1] ?? '';
}

describe('packaging/Containerfile', () => {
  it("part de l'image de base épinglée par digest, passée par image.sh", () => {
    const froms = [...containerfile.matchAll(/^FROM (\S+)/gm)].map(([, image]) => image);
    expect(froms.length).toBeGreaterThanOrEqual(2);
    for (const image of froms) expect(image).toBe('${BASE_IMAGE}');
    expect(read('packaging/image.sh')).toMatch(/--build-arg "BASE_IMAGE=\$DEBIAN_SLIM_IMAGE"/);
  });

  it("ne télécharge rien d'autre que des paquets Debian signés", () => {
    expect(containerfile).not.toMatch(/\b(curl|wget)\b|^ADD\s+https?:/m);
  });

  it("l'étape finale dépend de l'étape de contrôle (exécutée par Docker comme par Podman)", () => {
    expect(containerfile).toMatch(/^FROM \$\{BASE_IMAGE\} AS check$/m);
    expect(containerfile).toMatch(/^COPY --from=check \/app \/app$/m);
  });

  it('tourne en non-root (UID 10001), healthcheck en forme exec sans curl', () => {
    const users = [...containerfile.matchAll(/^USER (\S+)$/gm)].map(([, user]) => user);
    expect(users.at(-1)).toBe('10001:10101');
    expect(containerfile).toMatch(
      /^HEALTHCHECK .*CMD \["\/app\/node\/bin\/node", "\/app\/lockmaster\.mjs", "healthcheck"\]$/m,
    );
    expect(containerfile).toMatch(/^ENTRYPOINT \["\/app\/bin\/lockmaster"\]$/m);
  });

  it("crée les dossiers dont héritent les volumes, avec les propriétaires d'ADR-0007", () => {
    for (const expected of [
      '-m 2750 -o 10002 -g 10100 /run/lockmaster-sign',
      '-m 0700 -o 10002 -g 10100 /var/lib/lockmaster-signer',
      '-m 0750 -o 10001 -g 10101 /var/lib/lockmaster',
      '-m 2750 -o 10001 -g 10101 /srv/lockmaster-repo',
    ]) {
      expect(containerfile).toContain(`install -d ${expected}`);
    }
  });

  it('copie les licences tierces dans /usr/share/doc/lockmaster', () => {
    expect(containerfile).toMatch(/^COPY doc\/ \/usr\/share\/doc\/lockmaster\/$/m);
  });
});

describe('déploiements conteneur', () => {
  const env = versionsEnv();
  const pinned = [env.get('NGINX_UNPRIVILEGED_IMAGE'), env.get('CLAMAV_IMAGE')];

  it('compose et quadlets : images tierces épinglées par le digest de versions.env', () => {
    for (const [file, text] of [['deploy/compose.yaml', compose], ...quadlets.map((q) => [q, read(q)])] as const) {
      const images = [...text.matchAll(/^\s*(?:image: |Image=)(\S+)/gm)].map(([, image]) => image as string);
      for (const image of images.filter((ref) => !ref.includes('lockmaster'))) {
        expect(pinned, `${file} : ${image}`).toContain(image);
      }
    }
  });

  it("compose : l'image lockmaster est surchargeable (essais locaux), le signataire n'a aucun réseau", () => {
    expect(service('signer')).toMatch(/image: \$\{LOCKMASTER_IMAGE:-ghcr\.io\/tiotbenjy\/lockmaster:1\}/);
    expect(service('lockmaster')).toMatch(/image: \$\{LOCKMASTER_IMAGE:-ghcr\.io\/tiotbenjy\/lockmaster:1\}/);
    expect(service('signer')).toMatch(/network_mode: none/);
    expect(service('signer')).toMatch(/healthcheck: \{ disable: true \}/);
  });

  it('quadlets : chaque compte hôte est projeté sur l UID de son service dans l image', () => {
    expect(read('deploy/quadlet/lockmaster/lockmaster.container')).toMatch(/^UserNS=keep-id:uid=10001,gid=10101$/m);
    expect(read('deploy/quadlet/lockmaster-signer/lockmaster-signer.container')).toMatch(
      /^UserNS=keep-id:uid=10002,gid=10100$/m,
    );
  });
});
