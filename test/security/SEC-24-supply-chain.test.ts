import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };
import { makeTree, REPO_ROOT, runScript } from '../helpers/run-script.js';

// SEC-24 : chaîne d'approvisionnement de lockmaster lui-même. Tout binaire externe embarqué (Node.js,
// Grype, nfpm) est vérifié par une somme tirée d'un fichier signé ; better-sqlite3 est compilé depuis
// ses sources dans un conteneur épinglé ; pnpm refuse les scripts d'installation hors liste blanche et
// les versions trop récentes.

const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');
/** Code shell sans les lignes de commentaire. */
const code = (path: string) =>
  read(path)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

function shellScripts(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sh'))
    .map((entry) => join(entry.parentPath, entry.name).slice(REPO_ROOT.length + 1));
}

function versionsEnv(): Map<string, string> {
  const entries = read('packaging/versions.env')
    .split('\n')
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => line.split('=', 2) as [string, string]);
  return new Map(entries);
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Lance fetch_verified de packaging/lib.sh sur un fichier déjà en cache (aucun accès réseau). */
function fetchVerified(content: string, expectedSum: string) {
  const tree = makeTree({ 'packaging/versions.env': '', 'cache/file': content });
  try {
    copyFileSync(join(REPO_ROOT, 'packaging/lib.sh'), join(tree.root, 'packaging/lib.sh'));
    const script = join(tree.root, 'packaging/run.sh');
    writeFileSync(script, '. "$(dirname "$0")/lib.sh"\nfetch_verified "https://invalid.example/file" "$1" "$2"\n');
    const file = join(tree.root, 'cache/file');
    const result = spawnSync('sh', [script, expectedSum, file], { encoding: 'utf8', shell: false });
    return { status: result.status, stderr: result.stderr, kept: existsSync(file) };
  } finally {
    tree.cleanup();
  }
}

describe('SEC-24 : binaires externes vérifiés', () => {
  it('fetch_verified refuse et supprime un fichier en cache dont la somme diffère', () => {
    const result = fetchVerified('binaire altéré', sha256('binaire attendu'));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/somme SHA-256 incorrecte/);
    expect(result.kept).toBe(false);
  });

  it('fetch_verified accepte un fichier en cache dont la somme correspond', () => {
    const result = fetchVerified('binaire attendu', sha256('binaire attendu'));
    expect(result.status, result.stderr).toBe(0);
    expect(result.kept).toBe(true);
  });

  it('aucun script de livraison ne télécharge hors des deux fonctions vérifiées', () => {
    const downloaders = shellScripts('packaging').filter((script) => /\b(curl|wget)\b/.test(code(script)));
    expect(downloaders.sort()).toEqual(['packaging/lib.sh', 'packaging/update-pins.sh']);
    // lib.sh : un seul téléchargement, dans fetch_verified, suivi de la vérification.
    expect(code('packaging/lib.sh').match(/\bcurl\b/g)).toHaveLength(1);
    expect(code('packaging/lib.sh')).toMatch(/fetch_verified\(\) \{[^}]*curl[^}]*sha256sum -c/);
    for (const call of code('packaging/lib.sh').matchAll(/^\s*fetch_verified (.+)$/gm)) {
      expect(call[1]).toMatch(/^"https:\/\/[^"]+" "\$sum" "\$file"$/);
    }
  });

  it('update-pins.sh ne tire les sommes que de fichiers signés, vérifiés avec une ancre commitée', () => {
    const text = code('packaging/update-pins.sh');
    expect(text).toMatch(/gpgv --keyring "\$here\/keys\/nodejs-release-keys\.kbx"/);
    expect(existsSync(join(REPO_ROOT, 'packaging/keys/nodejs-release-keys.kbx'))).toBe(true);
    expect(text).toMatch(/--certificate-identity "\$3"/);
    expect(text).not.toMatch(/certificate-identity-regexp/);
    expect(text.match(/^verify_sigstore \S+ \S+ \\$/gm)).toHaveLength(2);
  });

  it('versions.env : chaque binaire a sa somme par architecture, chaque image un digest', () => {
    const env = versionsEnv();
    const sums = ['NODE_SHA256_X64', 'NODE_SHA256_ARM64', 'GRYPE_SHA256_AMD64', 'GRYPE_SHA256_ARM64'];
    for (const key of [...sums, 'NFPM_SHA256_X86_64', 'NFPM_SHA256_ARM64']) {
      expect(env.get(key), key).toMatch(/^[0-9a-f]{64}$/);
    }
    const images = [...env].filter(([key]) => key.endsWith('_IMAGE'));
    expect(images.length).toBeGreaterThan(0);
    for (const [key, ref] of images) expect(ref, key).toMatch(/^[a-z0-9./-]+@sha256:[0-9a-f]{64}$/);
  });
});

describe('SEC-24 : better-sqlite3 compilé depuis les sources', () => {
  it('build-native.sh supprime tout binaire précompilé et compile dans AlmaLinux 9 épinglée', () => {
    const text = code('packaging/build-native.sh');
    expect(text).toMatch(/rm -rf "\$work\/better-sqlite3\/prebuilds" "\$work\/better-sqlite3\/build"/);
    expect(text).toMatch(/"\$ALMALINUX_9_IMAGE"/);
    expect(text).toMatch(/node-gyp\.js \\\s*\n\s*rebuild/);
  });

  it('pnpm build refuse une livraison (--out) sans module natif compilé (--native)', () => {
    const tree = makeTree({});
    try {
      const out = join(tree.root, 'livraison');
      const result = runScript('scripts/build.mjs', [`--out=${out}`]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/--native obligatoire/);
      expect(existsSync(out)).toBe(false);
    } finally {
      tree.cleanup();
    }
  });

  it('stage.sh (paquets et image) passe toujours --native à la construction', () => {
    expect(code('packaging/stage.sh')).toMatch(/scripts\/build\.mjs" --out "[^"]+" --native "\$native"/);
    expect(code('packaging/package.sh')).toMatch(/packaging_dir\/stage\.sh"/);
    expect(code('packaging/image.sh')).toMatch(/packaging_dir\/stage\.sh"/);
  });
});

describe('SEC-24 : pnpm', () => {
  const workspace = read('pnpm-workspace.yaml');

  it('packageManager épinglé avec son empreinte, la même version dans le lockfile (ADR-0014)', () => {
    const pinned = /^pnpm@(12\.\d+\.\d+)\+sha512\.[0-9a-f]{128}$/.exec(packageJson.packageManager ?? '');
    expect(pinned, packageJson.packageManager).not.toBeNull();
    const lockfile = read('pnpm-lock.yaml');
    expect(lockfile).toMatch(
      new RegExp(
        `packageManagerDependencies:\\n {6}pnpm:\\n {8}specifier: ${pinned?.[1]}\\n {8}version: ${pinned?.[1]}\\n`,
      ),
    );
  });

  it('seuls better-sqlite3 et esbuild exécutent un script d installation', () => {
    const table = /^allowBuilds:\n((?: {2}\S.*\n)+)/m.exec(workspace)?.[1] ?? '';
    expect(table.split('\n').filter(Boolean)).toEqual(['  better-sqlite3: true', '  esbuild: true']);
    // Réglages qui élargiraient ou remplaceraient cette liste ; onlyBuiltDependencies est ignoré par
    // pnpm 12 et donnerait l'illusion d'un contrôle.
    expect(workspace).not.toMatch(
      /^\s*(onlyBuiltDependencies|neverBuiltDependencies|dangerouslyAllowAllBuilds|permissions):/m,
    );
  });

  it('le délai de publication reste strict', () => {
    expect(workspace).not.toMatch(/^\s*minimumReleaseAgeStrict: *false/m);
  });

  it('minimumReleaseAge d au moins 7 jours, exceptions limitées à des versions exactes', () => {
    expect(Number(/^minimumReleaseAge: (\d+)$/m.exec(workspace)?.[1])).toBeGreaterThanOrEqual(10_080);
    // Toute mention de la clé doit être une liste en bloc, non vide, de versions exactes : une autre
    // forme (liste en ligne, nom sans version, commentaire intercalé) échoue ici.
    const mentions = workspace.match(/^\s*minimumReleaseAgeExclude\b.*$/gm) ?? [];
    const excluded = /^minimumReleaseAgeExclude:\n((?: {2}- .+\n)+)/m.exec(workspace)?.[1];
    if (mentions.length > 0) {
      expect(mentions).toEqual(['minimumReleaseAgeExclude:']);
      expect(excluded).toBeDefined();
    }
    for (const line of (excluded ?? '').split('\n').filter(Boolean)) {
      expect(line).toMatch(/^ {2}- [@a-z0-9./-]+@\d+\.\d+\.\d+( \|\| \d+\.\d+\.\d+)*$/);
    }
  });
});

describe('SEC-24 : workflows CI', () => {
  const dir = join(REPO_ROOT, '.github/workflows');
  const workflows = existsSync(dir) ? readdirSync(dir).filter((file) => /\.ya?ml$/.test(file)) : [];

  // Les workflows arrivent en fin de M0 : la règle s'applique à chacun dès qu'il existe.
  it('aucun pull_request_target, actions tierces épinglées par SHA de commit', () => {
    for (const file of workflows) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text, file).not.toMatch(/pull_request_target/);
      for (const [, action] of text.matchAll(/^\s*-?\s*uses: (\S+)/gm)) {
        if (action?.startsWith('./')) continue;
        expect(action, file).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });
});
