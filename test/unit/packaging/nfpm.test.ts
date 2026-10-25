import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Règles des paquets .deb/.rpm (ADR-0007, ADR-0008, .claude/rules/packaging.md), vérifiées sur les
// fichiers nfpm et les scripts de maintenance. L'installation réelle est testée par test/deliverables/.

const ROOT = join(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const CONFIGS = ['packaging/nfpm.yaml', 'packaging/nfpm-repo.yaml'];

interface Entry {
  src?: string;
  dst?: string;
  type?: string;
}

/** Entrées de `contents:` (format simple de nos fichiers : une clé par ligne). */
function contents(config: string): Entry[] {
  const section =
    read(config)
      .split(/^contents:\n/m)[1]
      ?.split(/^\S/m)[0] ?? '';
  return section
    .split(/^ {2}- /m)
    .slice(1)
    .map((block) => {
      const entry: Entry = {};
      for (const [, key, value] of block.matchAll(/^\s*(src|dst|type): (.+)$/gm)) {
        entry[key as keyof Entry] = (value as string).trim();
      }
      return entry;
    });
}

function scripts(config: string): string[] {
  return [...read(config).matchAll(/^ {2}(?:postinstall|preremove|postremove|preinstall): (\S+)$/gm)].map(
    ([, path]) => path as string,
  );
}

describe('fichiers nfpm', () => {
  it.each(CONFIGS)('%s : chaque source du dépôt existe (out/ est produit par package.sh)', (config) => {
    const sources = contents(config)
      .filter((entry) => entry.type !== 'symlink' && entry.src?.startsWith('./') && !entry.src.startsWith('./out/'))
      .map((entry) => entry.src as string);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of [...sources, ...scripts(config)]) expect(existsSync(join(ROOT, source)), source).toBe(true);
  });

  it.each(CONFIGS)('%s : tout fichier sous /etc est un fichier de configuration conservé', (config) => {
    for (const entry of contents(config).filter((item) => item.dst?.startsWith('/etc/') && item.type !== 'dir')) {
      expect(entry.type, entry.dst).toBe('config|noreplace');
    }
  });

  it("le paquet de l'application livre toutes les unités, sysusers et tmpfiles de référence", () => {
    const shipped = new Set(contents('packaging/nfpm.yaml').map((entry) => entry.src));
    const references = [
      ...readdirSync(join(ROOT, 'packaging/systemd')).map((file) => `./packaging/systemd/${file}`),
      './packaging/sysusers/lockmaster.conf',
      './packaging/tmpfiles/lockmaster.conf',
    ];
    for (const reference of references) expect(shipped, reference).toContain(reference);
  });

  it("le paquet lockmaster-repo n'embarque ni code ni clé (ADR-0008)", () => {
    const sources = contents('packaging/nfpm-repo.yaml').map((entry) => entry.src ?? '');
    expect(sources.filter((source) => /out\/|\.mjs$|\.js$|bin\/|\.key$|\.pem$/.test(source))).toEqual([]);
  });
});

describe('scripts de maintenance', () => {
  const all = [...new Set(CONFIGS.flatMap(scripts))];

  it.each(all)('%s : POSIX sh, arrêt sur erreur, syntaxe valide', (script) => {
    const text = read(script);
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(text).toMatch(/^set -e$/m);
    expect(() => execFileSync('sh', ['-n', join(ROOT, script)], { stdio: 'pipe', shell: false })).not.toThrow();
  });

  it.each(all)('%s : ne démarre rien, ne génère aucun secret, ne supprime aucune donnée', (script) => {
    // Hors commentaires et hors messages affichés (heredoc MSG), qui citent des commandes à lancer.
    const code = read(script)
      .replace(/<<'MSG'\n[\s\S]*?\nMSG\n/g, '\n')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(code).not.toMatch(/systemctl\s+(--\S+\s+)*(start|restart|enable|reload)\b/);
    expect(code).not.toMatch(/gen-master|openssl|ssh-keygen|\binit\b.*lockmaster|lockmaster\s+init/);
    expect(code).not.toMatch(/\brm\s|rmdir|userdel|groupdel/);
  });
});

describe('package.sh', () => {
  it('ne télécharge rien sans vérification SHA-256 (fetch_verified de lib.sh)', () => {
    const text = read('packaging/package.sh');
    expect(text).not.toMatch(/\b(curl|wget)\b/);
    expect(text).toMatch(/node_tarball/);
    expect(text).toMatch(/grype_tarball/);
    expect(text).toMatch(/nfpm_tarball/);
  });
});
