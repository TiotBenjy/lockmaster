import { processRuntime, runCli } from './cli/index.js';

// Point d'entrée de `lockmaster` (paquets : /usr/bin/lockmaster ; image : /app/lockmaster.mjs).
// `serve` ne rend jamais la main : le processus se termine par ses gestionnaires de signaux.
// Masque 027 (comme UMask= de lockmaster.service) quel que soit le masque hérité : 022 dans un
// conteneur, où le groupe principal 10101 est partagé avec nginx.
process.umask(0o027);
process.exitCode = await runCli(process.argv.slice(2), processRuntime());
