import { parseArgs } from 'node:util';
import packageJson from '../../package.json' with { type: 'json' };
import { LockmasterError } from '../domain/errors.js';
import { configCheckCommand, configShowCommand } from './commands/config.js';
import { healthcheckCommand } from './commands/healthcheck.js';
import { initCommand } from './commands/init.js';
import { keysGenMasterCommand } from './commands/keys.js';
import { serveCommand } from './commands/serve.js';
import type { CliRuntime, CommandContext } from './context.js';
import { EXIT } from './exit-codes.js';

export type { CliRuntime } from './context.js';

// Point d'entrée de la CLI (docs/06 §4) : analyse des arguments (node:util), refus de root sauf
// pour init, conversion des erreurs typées en codes de sortie. Une erreur inattendue ne fuit pas.

interface Command {
  words: readonly string[];
  options: readonly string[];
  allowRoot: boolean;
  summary: string;
  run: (ctx: CommandContext) => Promise<number>;
}

const COMMANDS: readonly Command[] = [
  { words: ['serve'], options: ['config'], allowRoot: false, summary: 'démarre le service', run: serveCommand },
  {
    words: ['init'],
    options: ['config', 'non-interactive', 'admin-password-file'],
    allowRoot: true,
    summary: 'initialise la clé maîtresse et la base (idempotent)',
    run: initCommand,
  },
  {
    words: ['config', 'check'],
    options: ['config'],
    allowRoot: false,
    summary: 'valide la configuration',
    run: configCheckCommand,
  },
  {
    words: ['config', 'show'],
    options: ['config'],
    allowRoot: false,
    summary: 'affiche la configuration effective',
    run: configShowCommand,
  },
  {
    words: ['healthcheck'],
    options: ['config'],
    allowRoot: false,
    summary: 'sonde /healthz (code de retour)',
    run: healthcheckCommand,
  },
  {
    words: ['keys', 'gen-master'],
    options: ['out'],
    allowRoot: false,
    summary: 'génère une clé maîtresse',
    run: keysGenMasterCommand,
  },
];

const OPTIONS = {
  config: { type: 'string' },
  'non-interactive': { type: 'boolean' },
  'admin-password-file': { type: 'string' },
  out: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
} as const;

// Erreurs de configuration ou d'installation : code 78, inutile de relancer (RestartPreventExitStatus).
const CONFIG_ERROR = /^(CONFIG_|PATH_|NOT_INITIALIZED$|SECRET_FILE_|MASTER_KEY_)/;

function usage(): string {
  const lines = COMMANDS.map((command) => `  lockmaster ${command.words.join(' ').padEnd(20)} ${command.summary}`);
  return `Usage : lockmaster <commande> [--config <fichier>]\n\n${lines.join('\n')}\n`;
}

function usageError(runtime: CliRuntime, message: string): number {
  runtime.stderr.write(`${message}\n\n${usage()}`);
  return EXIT.USAGE;
}

export async function runCli(argv: readonly string[], runtime: CliRuntime): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    return usageError(runtime, (error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.version || values.help) {
    runtime.stdout.write(values.version ? `${packageJson.version}\n` : usage());
    return EXIT.OK;
  }
  const command = COMMANDS.find((c) => c.words.join(' ') === positionals.join(' '));
  if (!command) return usageError(runtime, `commande inconnue : « ${positionals.join(' ')} »`);
  const extra = Object.keys(values).filter((name) => !command.options.includes(name));
  if (extra.length > 0)
    return usageError(runtime, `option non prise en charge par cette commande : --${extra.join(', --')}`);
  if (runtime.uid === 0 && !command.allowRoot) {
    runtime.stderr.write("refus de s'exécuter en root : lancer sous le compte lockmaster (seul init accepte root)\n");
    return EXIT.NO_PERMISSION;
  }
  try {
    return await command.run({ runtime, options: values });
  } catch (error) {
    if (!(error instanceof LockmasterError)) {
      // Sortie d'erreur destinée à l'opérateur (journald), jamais à un client HTTP : la cause
      // (EADDRINUSE, EACCES...) est nécessaire au diagnostic d'une boucle de redémarrage.
      const code = (error as NodeJS.ErrnoException).code;
      runtime.stderr.write(`erreur inattendue${code ? ` (${code})` : ''} : ${(error as Error).message}\n`);
      return EXIT.SOFTWARE;
    }
    runtime.stderr.write(`${error.message}\n`);
    return CONFIG_ERROR.test(error.code) ? EXIT.CONFIG : EXIT.FAILURE;
  }
}

export function processRuntime(): CliRuntime {
  return { env: process.env, uid: process.getuid?.() ?? -1, stdout: process.stdout, stderr: process.stderr };
}
