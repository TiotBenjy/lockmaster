# ADR-0011 : Réactivité locale par Alpine.js (build CSP) et système de design

- Statut : accepté (exigence du porteur, 2026-10-25)
- Amende : ADR-0004 (« aucun JavaScript applicatif » devient « aucun JavaScript applicatif hors
  composants Alpine typés ») ; `docs/07`

## Contexte

Le porteur veut une interface **réactive** et **professionnelle**. htmx couvre les échanges avec le
serveur (fragments, SSE) mais pas les interactions purement locales : menus, onglets, filtres
instantanés sur une liste affichée, validation à la sortie d'un champ, dialogues de confirmation,
copier-coller, bascule de thème. Les faire par aller-retour serveur dégrade la réactivité ;
les faire en JS ad hoc éparpille du code non testé. La CSP stricte d'ADR-0004 doit être conservée.

## Décision

1. **Alpine.js, build CSP** (`@alpinejs/csp`, dépendance npm épinglée par le lockfile), empaquetée
   avec nos composants par esbuild dans `src/web/static/app.js`, servi depuis `'self'`. La build
   standard d'Alpine est interdite : elle évalue les expressions avec `new Function` et exigerait
   `unsafe-eval`. **La CSP d'ADR-0004 reste stricte** (`script-src 'self'`, `style-src 'self'`) ; seule
   la directive `font-src 'self'` est ajoutée pour les polices auto-hébergées (point 7).
2. **Composants typés** : toute logique est dans `src/web/client/components/<nom>.ts`, sous la forme
   d'une fabrique pure `export function nom(): NomState` enregistrée par `Alpine.data('nom', nom)`
   dans `src/web/client/main.ts`. Le HTML ne contient que des **références simples** (noms de
   propriétés ou de méthodes, `!` toléré, `item in items` pour `x-for`). Pas d'objet littéral, pas
   d'opérateur, pas d'argument, pas d'affectation dans les attributs.
3. **Typage TSX** : `src/web/jsx-alpine.d.ts` augmente les attributs JSX ; `x-data` n'accepte que
   l'union des noms de composants enregistrés (`AlpineComponentName`), donc une faute de frappe ne
   compile pas. Syntaxe longue (`x-on:click`, `x-bind:class`) car `@click` et `:class` ne sont pas
   des noms d'attribut JSX valides.
4. **Interdits** (hook `guard-forbidden-patterns` + test CI) : `x-html` ; dans `src/web/client/` :
   `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `fetch` direct (les échanges
   serveur passent par htmx et son en-tête CSRF), `eval`, `new Function` ; `import 'alpinejs'`
   (build standard).
5. **Rôles respectifs** : htmx = tout ce qui lit ou modifie l'état serveur ; Alpine = état d'affichage
   local et éphémère. Le serveur reste la seule autorité (droits, validation, décisions) ; la
   validation côté client n'est qu'un confort.
6. **Dégradation** : les actions essentielles restent des formulaires POST qui fonctionnent sans JS.
7. **Système de design** : `docs/12-systeme-de-design.md` (jetons de couleur vérifiés AA en clair
   et en sombre, typographie système, icônes Phosphor générées en TSX, composants et états,
   mouvement minimal), polices **Inter** et **JetBrains Mono** (OFL) livrées dans
   `src/web/static/fonts/` avec licences et `SHA256SUMS`, jamais chargées depuis un tiers ; dérivé du skill `ui-ux-pro-max` vendorisé dans `.claude/skills/` et adapté
   aux contraintes du projet. Règles d'application : `.claude/rules/ui.md`.

Composants Alpine prévus : `navDisclosure`, `menu`, `tabs`, `listFilter` (filtre instantané d'une
liste déjà rendue), `formValidation`, `confirmDialog`, `copyButton`, `secretOnce`, `themeToggle`,
`flashQueue`, `bulkSelect` (file de revue), `relativeTime`.

## Alternatives écartées

- **JS ad hoc** (`static/copy.js` d'ADR-0004 étendu) : pas de structure, pas de tests, croissance
  anarchique.
- **Preact hydraté côté client / îlots** : bundle plus lourd, double rendu, état dupliqué ; contraire
  à ADR-0004.
- **Build standard d'Alpine** : exige `unsafe-eval`.
- **Trusted Types** (`require-trusted-types-for 'script'`) : incompatible avec les échanges htmx sans
  politique dédiée ; à réévaluer en M10.

## Conséquences

- Dépendances : `@alpinejs/csp` (exécution, empaquetée) ; dev : `happy-dom` (tests unitaires des
  composants qui touchent au DOM), `@playwright/test` et `@axe-core/playwright` (parcours et
  accessibilité), `@phosphor-icons/core` (source des icônes, extraites au build). Chacune justifiée
  dans son commit d'ajout.
- `pnpm build` compile `src/web/client/main.ts` -> `static/app.js` (minifié, avec carte de source
  hors paquet) ; un test vérifie que `app.js` ne contient ni `new Function` ni `eval(`.
- Le hook d'Alpine `x-cloak` impose la règle CSS `[x-cloak]{display:none!important}` dans `app.css`.
  `x-show` modifie `element.style` par le CSSOM, ce que la CSP autorise (seuls les attributs `style=`
  dans le balisage sont bloqués) ; vérifié par les tests Playwright « zéro violation CSP ».
- Avant M6, l'agent `researcher` vérifie dans la documentation officielle d'Alpine le sous-ensemble
  d'expressions accepté par la build CSP de la version épinglée ; notre règle (références simples)
  doit en être un sous-ensemble.
- Tests : unitaires sur les fabriques (état, méthodes) avec vitest (+ happy-dom si `$el`/`$refs`),
  rendu serveur avec `app.inject`, parcours Playwright + axe (`docs/10`, `docs/12` §12).
