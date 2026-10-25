import { isIP } from 'node:net';
import { type CommandContext, loadContextConfig } from '../context.js';

// `lockmaster healthcheck` : sonde du HEALTHCHECK conteneur (forme exec, sans curl) et des tests de
// livraison. Interroge /healthz sur l'adresse d'écoute ; code 0 si « ok », 1 sinon. Hors du périmètre
// du client sortant de src/net/ parce qu'elle ne joint qu'une adresse IP littérale (boucle locale
// pour 0.0.0.0 et ::), sans résolution DNS, et ne lit que quelques octets de réponse.

const TIMEOUT_MS = 3_000;
const MAX_BODY_BYTES = 16;

function probeHost(host: string): string | undefined {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '[::1]';
  const family = isIP(host);
  if (family === 4) return host;
  if (family === 6) return `[${host}]`;
  return undefined;
}

async function readBounded(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function healthcheckCommand(ctx: CommandContext): Promise<number> {
  const { host, port } = loadContextConfig(ctx).http.listen;
  const target = probeHost(host);
  if (!target) {
    ctx.runtime.stderr.write('http.listen doit être une adresse IP pour la sonde (pas de résolution DNS)\n');
    return 1;
  }
  try {
    const response = await fetch(`http://${target}:${port}/healthz`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    const healthy = response.ok && (await readBounded(response)) === 'ok';
    ctx.runtime.stdout.write(healthy ? 'ok\n' : `en échec (HTTP ${response.status})\n`);
    return healthy ? 0 : 1;
  } catch {
    ctx.runtime.stderr.write('lockmaster ne répond pas\n');
    return 1;
  }
}
