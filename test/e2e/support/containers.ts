// Conteneurs des tests e2e, pilotés par la CLI de Podman (ou de Docker si Podman est absent) :
// execFile sans shell côté hôte, images épinglées par digest dans packaging/versions.env, données
// passées par stdin. testcontainers n'est pas utilisé : il tire des paquets à script d'installation
// hors de la liste `allowBuilds` (cpu-features, protobufjs, ssh2).

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../../..');
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

function hasEngine(name: string): boolean {
  try {
    execFileSync(name, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const ENGINES = ['podman', 'docker'];

/** Moteur de conteneurs : LOCKMASTER_E2E_ENGINE (podman ou docker), sinon podman, sinon docker. */
function chooseEngine(): string {
  const requested = process.env['LOCKMASTER_E2E_ENGINE'];
  if (requested === undefined) return hasEngine('podman') ? 'podman' : 'docker';
  if (!ENGINES.includes(requested)) throw new Error('LOCKMASTER_E2E_ENGINE : podman ou docker');
  return requested;
}

export const engine = chooseEngine();

/** Référence épinglée (`<NOM>_IMAGE`) de packaging/versions.env. */
export function pinnedImage(name: string): string {
  const env = readFileSync(join(ROOT, 'packaging/versions.env'), 'utf8');
  const line = env.split('\n').find((entry) => entry.startsWith(`${name}_IMAGE=`));
  if (line === undefined) throw new Error(`image ${name} absente de packaging/versions.env`);
  return line.slice(`${name}_IMAGE=`.length);
}

function run(args: readonly string[], input?: string | Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      engine,
      args,
      { maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8', timeout: 540_000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${engine} ${args.slice(0, 3).join(' ')} : ${error.message}\n${stderr}`));
        else resolve(stdout);
      },
    );
    child.stdin?.end(input ?? '');
  });
}

export interface Container {
  /** Script sh exécuté dans le conteneur, stdin facultatif ; rend la sortie standard. */
  sh(script: string, input?: string | Uint8Array): Promise<string>;
  /** Contenu d'un fichier du conteneur. */
  read(path: string): Promise<Uint8Array>;
  stop(): Promise<void>;
}

export async function startContainer(image: string): Promise<Container> {
  const id = (await run(['run', '-d', '--rm', image, 'sleep', 'infinity'])).trim();
  return {
    sh: (script, input) => run(['exec', '-i', id, 'sh', '-c', script], input),
    read: async (path) => Buffer.from((await run(['exec', id, 'base64', path])).replace(/\s/g, ''), 'base64'),
    stop: async () => {
      await run(['rm', '-f', '-t', '0', id]);
    },
  };
}
