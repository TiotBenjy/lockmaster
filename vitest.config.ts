import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';

// Quatre projets (docs/10) :
//  - unit        : test/**/*.test.ts hors des dossiers ci-dessous (rapides, sans réseau ni conteneur) ;
//  - integration : test/integration/** (processus réels, SQLite temporaire, fastify.inject) ;
//  - fuzz        : test/**/*.fuzz.test.ts (fast-check ; FC_NUM_RUNS fixe le nombre d'essais) ;
//  - e2e         : test/e2e/** (conteneurs pilotés par la CLI Podman ou Docker, ADR-0016).
// Seuils de couverture : docs/10 §Couverture (ne jamais les abaisser, SEC-19).
const SLOW = ['test/integration/**', 'test/e2e/**', 'test/**/*.fuzz.test.ts'];

// Migrations SQL embarquées (src/**/migrations/*.sql) : importées comme texte, comme le font esbuild
// (`loader: { '.sql': 'text' }`, scripts/build.mjs) et le hook de `pnpm dev` (scripts/sql-text-hook.mjs).
const sqlText: Plugin = {
  name: 'lockmaster-sql-text',
  load(id) {
    if (!id.endsWith('.sql')) return null;
    return `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`;
  },
};
const plugins = [sqlText];

export default defineConfig({
  test: {
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/web/static/**'],
      thresholds: {
        lines: 80,
        branches: 80,
        'src/formats/**': { lines: 90, branches: 90 },
        'src/crypto/**': { lines: 90, branches: 90 },
        'src/auth/**': { lines: 90, branches: 90 },
        'src/pipeline/**': { lines: 90, branches: 90 },
      },
    },
    projects: [
      { plugins, test: { name: 'unit', include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], exclude: SLOW } },
      { plugins, test: { name: 'integration', include: ['test/integration/**/*.test.ts'], testTimeout: 30_000 } },
      { plugins, test: { name: 'fuzz', include: ['test/**/*.fuzz.test.ts'], testTimeout: 600_000 } },
      { plugins, test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'], testTimeout: 600_000 } },
    ],
  },
});
