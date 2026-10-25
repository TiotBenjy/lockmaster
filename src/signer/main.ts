import { runSignerCli } from './cli.js';

// Point d'entrée du service de signature (bundle distinct de l'application : dist/lockmaster-signer.mjs).
// `serve` ne rend jamais la main : le processus se termine par ses gestionnaires de signaux.
// Tout fichier du signataire (base, journal) naît inaccessible aux autres comptes, quel que soit le
// masque hérité (022 dans un conteneur, groupe principal partagé en compose).
process.umask(0o077);
process.exitCode = await runSignerCli(process.argv.slice(2), {
  env: process.env,
  uid: process.getuid?.() ?? -1,
  pid: process.pid,
  stdout: process.stdout,
  stderr: process.stderr,
});
