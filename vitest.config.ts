import { defineConfig } from 'vitest/config';

// Quatre projets (docs/10) :
//  - unit        : test/**/*.test.ts hors des dossiers ci-dessous (rapides, sans réseau ni conteneur) ;
//  - integration : test/integration/** (processus réels, SQLite temporaire, fastify.inject) ;
//  - fuzz        : test/**/*.fuzz.test.ts (fast-check ; FC_NUM_RUNS fixe le nombre d'essais) ;
//  - e2e         : test/e2e/** (testcontainers : Docker ou Podman).
// Seuils de couverture : docs/10 §Couverture (ne jamais les abaisser, SEC-19).
const SLOW = ['test/integration/**', 'test/e2e/**', 'test/**/*.fuzz.test.ts'];

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
      { test: { name: 'unit', include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], exclude: SLOW } },
      { test: { name: 'integration', include: ['test/integration/**/*.test.ts'], testTimeout: 30_000 } },
      { test: { name: 'fuzz', include: ['test/**/*.fuzz.test.ts'], testTimeout: 600_000 } },
      { test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'], testTimeout: 600_000 } },
    ],
  },
});
