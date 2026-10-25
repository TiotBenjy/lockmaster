# ADR-0004 : Interface rendue côté serveur (TSX Preact + htmx), aucun bundle client

- Statut : accepté, **amendé par ADR-0011** (réactivité locale par des composants Alpine.js build CSP,
  compilés dans `static/app.js` ; la CSP ci-dessous n'a gagné que `font-src 'self'` pour les polices
  auto-hébergées de `src/web/static/fonts/`)
- Date : 2026-10-19

## Contexte

Une SPA React représente vite des dizaines de milliers de lignes (pages de plus de 1 000 lignes),
une chaîne Vite/Tailwind/npm séparée, un conteneur nginx dédié et un jeton manipulé côté navigateur
(piège A1). Les besoins réels sont des tableaux, formulaires, filtres et quelques
mises à jour en direct (progression d'import/scan).

## Décision

- Les pages sont des **composants TSX** rendus en chaîne HTML côté serveur avec
  `preact-render-to-string`. Aucune hydratation ; le seul JavaScript applicatif est
  celui des composants Alpine d'ADR-0011, un seul `tsc` pour tout le projet.
- L'échappement est automatique (JSX). `dangerouslySetInnerHTML` est **interdit sans exception**
  (règle Biome + hook + test de recherche dans la CI). Le seul HTML non produit par JSX est la
  coque du document (`<!doctype html>`), ajoutée comme chaîne constante par `src/web/render.ts`.
- **htmx** (fichier vendorisé dans `src/web/static/`, version épinglée, hash SHA-384 vérifié
  par un test) pour les mises à jour partielles ; **SSE** pour la progression des jobs.
- CSS écrit à la main (un fichier, variables CSS, mode sombre), pas de framework ni de build ;
  polices Inter et JetBrains Mono auto-hébergées (`src/web/static/fonts/`, `docs/12` §3).
- CSP stricte, sans exception :
  `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`.
  Donc aucun attribut `on*=`, aucun `<script>` inline, aucun `style=` inline
  (htmx configuré avec `htmx.config.includeIndicatorStyles = false`).
- Session par cookie `__Host-lockmaster_session` (`Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`),
  jeton CSRF synchronisé exigé sur toute requête non-GET de l'UI (en-tête `X-CSRF-Token`
  ajouté par htmx via `hx-headers` sur `<body>`, ou champ caché dans les formulaires).
- L'API JSON (`/api/v1`) est destinée à la CLI et à la CI : authentification **uniquement**
  par jeton d'API (`Authorization: Bearer`), jamais par cookie -> pas de CSRF possible sur l'API.

## Conséquences

- Plus de `localStorage` contenant un jeton, plus de CORS (même origine, CORS désactivé).
- Tests UI : tests HTTP (`fastify.inject`) qui vérifient le HTML rendu, les en-têtes de
  sécurité et les contrôles d'accès ; Playwright optionnel pour 3-4 parcours critiques.
- Le développeur front écrit du TSX familier, avec les mêmes types que le backend.
