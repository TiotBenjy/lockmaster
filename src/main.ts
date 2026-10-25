import { processRuntime, runCli } from './cli/index.js';

// Point d'entrée de `lockmaster` (paquets : /usr/bin/lockmaster ; image : /app/lockmaster.mjs).
// `serve` ne rend jamais la main : le processus se termine par ses gestionnaires de signaux.
process.exitCode = await runCli(process.argv.slice(2), processRuntime());
