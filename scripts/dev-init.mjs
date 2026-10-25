#!/usr/bin/env node
// `pnpm dev:init` : prépare un environnement de développement JETABLE dans le dossier courant.
//  - ./lockmaster.dev.toml : configuration de dev (ignorée par git, recopiée dans les worktrees) ;
//  - ./.data/              : données de dev (base, blobs), 0700 ;
//  - ./.data-keys/         : clé maîtresse de dev, 0600. Hors de .data, car lockmaster refuse une clé
//                            maîtresse située sous data_dir (docs/02 §3.3).
// Ne remplace jamais un fichier existant. Aucune vraie clé ni vrai secret (SEC-20).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const CONFIG = 'lockmaster.dev.toml';
const KEY = join('.data-keys', 'dev-master.key');

const TEMPLATE = `# Configuration de DÉVELOPPEMENT générée par \`pnpm dev:init\` : jetable, ignorée par git.
# Référence de toutes les clés : deploy/lockmaster.example.toml. Chemins relatifs à ce fichier.

[server]
public_url = "http://127.0.0.1:8080"
data_dir   = "./.data"

[http]
listen = "127.0.0.1:8080"

[security]
master_key_file = "./${KEY}"

[signer]
socket = "./.data-signer/sign.sock"

[[publish.targets]]
name       = "local"
kind       = "local"
path       = "./.data-repo"
public_url = "http://127.0.0.1:8081"

[scanners.grype]
db_dir = "./.data/vulndb"

[log]
level = "debug"
`;

for (const dir of ['.data', '.data-keys']) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });

if (existsSync(join(root, CONFIG))) {
  console.log(`${CONFIG} existe déjà : conservé.`);
} else {
  writeFileSync(join(root, CONFIG), TEMPLATE, { flag: 'wx', mode: 0o600 });
  console.log(`${CONFIG} créé.`);
}

if (existsSync(join(root, KEY))) {
  console.log(`${KEY} existe déjà : conservée.`);
} else {
  writeFileSync(join(root, KEY), `${randomBytes(32).toString('base64')}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`${KEY} créée (clé maîtresse de développement, jetable).`);
}
