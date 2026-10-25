import { type CommandContext, loadContextConfig } from '../context.js';

// `lockmaster healthcheck` : sonde du HEALTHCHECK conteneur (forme exec, sans curl) et des tests de
// livraison. Interroge /healthz sur l'interface locale ; code 0 si « ok », 1 sinon. Requête vers la
// boucle locale uniquement : hors du périmètre du client sortant de src/net/.

const TIMEOUT_MS = 3_000;

function localHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '[::1]';
  return host.includes(':') ? `[${host}]` : host;
}

export async function healthcheckCommand(ctx: CommandContext): Promise<number> {
  const { host, port } = loadContextConfig(ctx).http.listen;
  try {
    const response = await fetch(`http://${localHost(host)}:${port}/healthz`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    const healthy = response.ok && (await response.text()) === 'ok';
    ctx.runtime.stdout.write(healthy ? 'ok\n' : `en échec (HTTP ${response.status})\n`);
    return healthy ? 0 : 1;
  } catch {
    ctx.runtime.stderr.write('lockmaster ne répond pas\n');
    return 1;
  }
}
