#!/usr/bin/env node
// `pnpm build` : artefact unique emballé ensuite en .deb, .rpm et image OCI (ADR-0007).
//  - dist/lockmaster.mjs         : application (src/main.ts) ;
//  - dist/lockmaster-signer.mjs  : service de signature (src/signer/main.ts), bundle DISTINCT : aucun
//                                  code du signataire dans l'application, et inversement (ADR-0009) ;
//  - dist/node_modules/better-sqlite3 : seul module externe (natif), avec le binaire fourni par
//                                  --native (compilé depuis les sources, packaging/build-native.sh) ou,
//                                  à défaut, celui de node_modules (développement, tests) ;
//  - dist/static, dist/LICENSE, dist/THIRD-PARTY-LICENSES.txt.
// Usage : node scripts/build.mjs [--out=dist] [--native=chemin/better_sqlite3.node]
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: { out: { type: 'string' }, native: { type: 'string' } } });
const out = resolve(root, values.out ?? 'dist');

// Les dépendances CommonJS (fastify, pino...) appellent require() : on le fournit au bundle ESM.
const banner =
  "import { createRequire as __lockmasterRequire } from 'node:module';\nconst require = __lockmasterRequire(import.meta.url);";

async function bundle(entry, file) {
  await build({
    entryPoints: [join(root, entry)],
    outfile: join(out, file),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    external: ['better-sqlite3'],
    banner: { js: banner },
    legalComments: 'none',
    logLevel: 'warning',
  });
}

function nativeBinary() {
  if (values.native) return resolve(values.native);
  const pkg = join(root, 'node_modules/better-sqlite3');
  const built = join(pkg, 'build/Release/better_sqlite3.node');
  if (existsSync(built)) return built;
  const prebuilt = join(pkg, `prebuilds/linux-${arch()}.node`);
  if (existsSync(prebuilt)) return prebuilt;
  throw new Error('module natif de better-sqlite3 introuvable : utiliser --native');
}

function copySqlite() {
  const source = join(root, 'node_modules/better-sqlite3');
  const target = join(out, 'node_modules/better-sqlite3');
  mkdirSync(join(target, 'build/Release'), { recursive: true });
  cpSync(join(source, 'lib'), join(target, 'lib'), { recursive: true });
  for (const file of ['package.json', 'LICENSE']) cpSync(join(source, file), join(target, file));
  cpSync(nativeBinary(), join(target, 'build/Release/better_sqlite3.node'));
}

function thirdPartyLicenses() {
  const report = JSON.parse(
    execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], { cwd: root, encoding: 'utf8', shell: false }),
  );
  const sections = [];
  for (const [license, packages] of Object.entries(report)) {
    for (const pkg of packages) {
      const dir = pkg.paths?.[0];
      const file = dir && ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license'].map((f) => join(dir, f)).find(existsSync);
      const text = file
        ? readFileSync(file, 'utf8').trim()
        : `(texte de licence non fourni par le paquet ; ${license})`;
      sections.push(`${pkg.name} ${pkg.versions.join(', ')} : ${license}\n\n${text}\n`);
    }
  }
  sections.sort();
  return `Licences des dépendances de production de lockmaster\n${'='.repeat(52)}\n\n${sections.join(`\n${'-'.repeat(72)}\n\n`)}`;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await bundle('src/main.ts', 'lockmaster.mjs');
await bundle('src/signer/main.ts', 'lockmaster-signer.mjs');
copySqlite();
if (existsSync(join(root, 'src/web/static')))
  cpSync(join(root, 'src/web/static'), join(out, 'static'), { recursive: true });
cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'));
writeFileSync(join(out, 'THIRD-PARTY-LICENSES.txt'), thirdPartyLicenses());
console.log(`build : ${out}`);
