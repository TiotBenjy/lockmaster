import { generateMasterKeyText } from '../../crypto/master-key.js';
import type { CommandContext } from '../context.js';
import { writeNewFile } from '../files.js';

// `lockmaster keys gen-master [--out F]` : nouvelle clé maîtresse (32 octets aléatoires, base64).
// Sans --out : sur la sortie standard (pour `podman secret create ... -`). Avec --out : fichier
// 0400 créé en exclusivité, sans suivre de lien.

export async function keysGenMasterCommand(ctx: CommandContext): Promise<number> {
  const out = ctx.options['out'];
  const key = generateMasterKeyText();
  if (typeof out === 'string') {
    writeNewFile(out, key, 0o400);
    ctx.runtime.stderr.write(`clé maîtresse écrite dans ${out} (0400)\n`);
  } else {
    ctx.runtime.stdout.write(key);
  }
  return 0;
}
