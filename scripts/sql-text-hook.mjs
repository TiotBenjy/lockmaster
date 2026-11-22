// Hook de chargement pour `pnpm dev` (tsx) : un fichier .sql importé devient un module dont l'export
// par défaut est son texte, comme dans le bundle (esbuild, `loader: { '.sql': 'text' }`) et sous
// vitest. Chargé par `--import` ; sans effet sur les autres modules.
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !url.endsWith('.sql')) return nextLoad(url, context);
    const text = readFileSync(fileURLToPath(url), 'utf8');
    return { format: 'module', source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  },
});
