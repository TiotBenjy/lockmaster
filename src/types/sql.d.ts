// Fichiers SQL embarqués comme texte (migrations) : esbuild (scripts/build.mjs), vitest
// (vitest.config.ts) et `pnpm dev` (scripts/sql-text-hook.mjs) les chargent de la même façon.
declare module '*.sql' {
  const text: string;
  export default text;
}
