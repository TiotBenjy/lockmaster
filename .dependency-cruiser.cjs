// Règles de couches de lockmaster (docs/01 §6). Exécuté par `pnpm check` et en CI.
// Une règle ajoutée ici se teste dans test/integration/dependency-rules.test.ts.

const IO_MODULES = '^src/(db|net|storage|publish|scan|signer-client|jobs|http|cli|notify|stats|upstream)/';
const NODE_IO = '^(node:)?(fs|fs/promises|net|child_process|http|https|http2|dgram|tls|dns|worker_threads)$';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Aucun cycle de dépendances (docs/01 §6).',
      from: {},
      to: { circular: true },
    },
    {
      name: 'pure-core-no-io-module',
      severity: 'error',
      comment: "domain/ et formats/ restent purs : aucun module d'infrastructure (docs/01 §6).",
      from: { path: '^src/(domain|formats)/' },
      to: { path: IO_MODULES },
    },
    {
      name: 'pure-core-no-node-io',
      severity: 'error',
      comment: "domain/ et formats/ n'utilisent aucune API d'I/O de Node (docs/01 §6).",
      from: { path: '^src/(domain|formats)/' },
      to: { dependencyTypes: ['core'], path: NODE_IO },
    },
    {
      name: 'http-web-no-db',
      severity: 'error',
      comment: 'Les routes et pages appellent des services, jamais la base (CLAUDE.md).',
      from: { path: '^src/(http|web)/' },
      to: { path: '^src/db/' },
    },
    {
      name: 'only-signer-imports-signer',
      severity: 'error',
      comment: "ADR-0009 : l'application passe par src/signer-client/, jamais par src/signer/.",
      from: { path: '^src/', pathNot: '^src/(signer/|main\\.ts$|cli/signer)' },
      to: { path: '^src/signer/' },
    },
    {
      name: 'signer-isolated',
      severity: 'error',
      comment: "ADR-0009 : le signataire n'a ni réseau, ni HTTP, ni accès à la base de l'application.",
      from: { path: '^src/signer/' },
      to: { path: '^src/(net|http|db|web|publish|pipeline|auth|jobs|upstream|scan|storage|signer-client)/' },
    },
    {
      name: 'signer-no-network-api',
      severity: 'error',
      comment: 'ADR-0009 : aucune API réseau dans le signataire (socket Unix par node:net seulement).',
      from: { path: '^src/signer/' },
      to: { dependencyTypes: ['core'], path: '^(node:)?(http|https|http2|dgram|tls|dns)$' },
    },
    {
      name: 'web-client-isolated',
      severity: 'error',
      comment: "ADR-0011 : le code navigateur n'importe aucun module serveur.",
      from: { path: '^src/web/client/' },
      to: { path: '^src/', pathNot: '^src/web/client/' },
    },
    {
      name: 'web-client-no-node',
      severity: 'error',
      comment: "ADR-0011 : le code navigateur n'utilise aucun module de Node.",
      from: { path: '^src/web/client/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'sandbox-no-secrets',
      severity: 'error',
      comment: "Le code qui analyse les paquets non fiables n'accède ni à la base, ni aux secrets, ni au réseau.",
      from: { path: '^src/pipeline/sandbox/' },
      to: { path: '^src/(db|crypto|signer-client|signer|net|config)/' },
    },
    {
      name: 'targets-independent',
      severity: 'error',
      comment: 'Les cibles de publication sont indépendantes les unes des autres.',
      from: { path: '^src/publish/targets/([^/]+)\\.ts$' },
      to: {
        path: '^src/publish/targets/',
        pathNot: ['^src/publish/targets/$1\\.ts$', '^src/publish/targets/types\\.ts$'],
      },
    },
    {
      name: 'src-not-from-tests',
      severity: 'error',
      comment: "Le code livré n'importe jamais le code de test.",
      from: { path: '^src/' },
      to: { path: '^test/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^(node_modules|dist|out|coverage|\\.claude)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs'],
    },
  },
};
