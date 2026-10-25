import { parseArgs } from 'node:util';
import { LockmasterError } from '../domain/errors.js';
import { installProcessHandlers } from '../process/lifecycle.js';
import { EXIT } from '../system/exit-codes.js';
import { activationFd } from './activation.js';
import { loadSignerConfig, resolveSignerConfigPath, type SignerConfig } from './config.js';
import { initSigner } from './init.js';
import { startSigner } from './server.js';

// CLI du signataire : `lockmaster signer init|serve` (le lanceur /usr/bin/lockmaster aiguille la
// sous-commande `signer` vers ce point d'entrée distinct, src/signer/main.ts). Jamais en root.

export interface SignerCliRuntime {
  env: Readonly<Record<string, string | undefined>>;
  uid: number;
  pid: number;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

const OPTIONS = {
  config: { type: 'string' },
  socket: { type: 'string' },
  'socket-activation': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

const USAGE = `Usage : lockmaster signer <commande> [--config <fichier>]

  lockmaster signer init                 clé maîtresse du signataire et base (idempotent)
  lockmaster signer serve                écoute sur socket.path de la configuration
  lockmaster signer serve --socket P     écoute sur le chemin P
  lockmaster signer serve --socket-activation   socket transmis par systemd
`;

const CONFIG_ERROR = /^(CONFIG_|PATH_|NOT_INITIALIZED$|SECRET_FILE_|MASTER_KEY_|SIGNER_SOCKET_|SIGNER_ACTIVATION_)/;
const SHUTDOWN_TIMEOUT_MS = 8_000;

function loadConfig(runtime: SignerCliRuntime, cliPath: string | undefined): SignerConfig {
  const { path, explicit } = resolveSignerConfigPath(cliPath, runtime.env);
  return loadSignerConfig({ path, env: runtime.env, explicit });
}

async function serve(runtime: SignerCliRuntime, config: SignerConfig, activation: boolean): Promise<number> {
  const signer = await startSigner(config, activation ? { fd: activationFd(runtime.env, runtime.pid) } : {});
  installProcessHandlers({
    process,
    exit: (code) => process.exit(code),
    logger: signer.logger,
    onShutdown: signer.stop,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
  });
  return new Promise<number>(() => {});
}

export async function runSignerCli(argv: readonly string[], runtime: SignerCliRuntime): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    runtime.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    runtime.stdout.write(USAGE);
    return EXIT.OK;
  }
  const command = positionals.join(' ');
  const serveOnly = values.socket !== undefined || values['socket-activation'] !== undefined;
  if (
    !['init', 'serve'].includes(command) ||
    (command === 'init' && serveOnly) ||
    (values.socket && values['socket-activation'])
  ) {
    runtime.stderr.write(`commande ou options invalides : « signer ${command} »\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  if (runtime.uid === 0) {
    runtime.stderr.write("refus de s'exécuter en root : lancer sous le compte lockmaster-signer\n");
    return EXIT.NO_PERMISSION;
  }
  try {
    const config = loadConfig(runtime, values.config);
    if (values.socket) config.socket.path = values.socket;
    if (command === 'init') {
      runtime.stdout.write(`${initSigner(config).join('\n')}\nSignataire initialisé.\n`);
      return EXIT.OK;
    }
    return await serve(runtime, config, values['socket-activation'] === true);
  } catch (error) {
    if (!(error instanceof LockmasterError)) {
      const code = (error as NodeJS.ErrnoException).code;
      runtime.stderr.write(`erreur inattendue${code ? ` (${code})` : ''} : ${(error as Error).message}\n`);
      return EXIT.SOFTWARE;
    }
    runtime.stderr.write(`${error.message}\n`);
    return CONFIG_ERROR.test(error.code) ? EXIT.CONFIG : EXIT.FAILURE;
  }
}
