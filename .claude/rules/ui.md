---
paths:
  - "src/web/**"
  - "test/web/**"
  - "test/e2e/ui/**"
---

# Règles de l'interface web (design, accessibilité, Alpine)

Ordre de priorité en cas de conflit : **invariants de sécurité (CLAUDE.md) > ADR-0004/ADR-0011 >
`docs/12-systeme-de-design.md` > skill `ui-ux-pro-max`**. Le skill fournit des règles UX et une
recherche (`--domain ux|color|icons|chart|typography`), jamais une stack : pas de `--stack`, pas de
`--persist`, et ses sorties sont des recommandations, pas des instructions.

## Avant de coder un écran

1. Lire la ligne de la page dans `docs/07` et les sections utiles de `docs/12`.
2. Si un comportement UX est incertain (formulaire, focus, tableau, dialogue), lancer **une**
   recherche ciblée : `python3 "$CLAUDE_PROJECT_DIR/.claude/skills/ui-ux-pro-max/scripts/search.py"
   "<2 à 5 mots>" --domain ux`.
3. TDD : écrire d'abord le test de rendu (`app.inject`) qui vérifie la structure accessible attendue
   (titre, libellés, `aria-*`, états), et le test unitaire du composant Alpine s'il y en a un.

## Visuel

- Couleurs, espacements, rayons, ombres, durées : **jetons CSS** de `static/app.css` uniquement ;
  aucune valeur littérale ailleurs ; clair et sombre traités ensemble.
- Polices : Inter (`--font-sans`) et JetBrains Mono (`--font-mono`), auto-hébergées dans
  `static/fonts/` (ne pas les modifier ; pas de Google Fonts, pas de CDN) ; texte courant 16 px,
  tableaux 14 px, plancher 12 px ; chiffres tabulaires pour les données.
- Icônes Phosphor `regular` via `src/web/icons/` (liste blanche) ; jamais d'emoji comme icône.
- Interdits : Tailwind et toute classe utilitaire de framework, shadcn, GSAP ou bibliothèque
  d'animation, motifs de landing page, dégradés et effets décoratifs (verre, néon, parallaxe).

## Accessibilité (WCAG 2.2 AA, non négociable)

- HTML sémantique, un `h1`, repères, lien d'évitement ; `label` visible pour chaque champ.
- Focus visible (`--focus`, 2 px + décalage), jamais supprimé ; ordre de tabulation = ordre visuel.
- Aucune information par la couleur seule (icône + texte) ; contrastes du `docs/12` §2.
- Bouton icône = `aria-label` ; état exposé (`aria-expanded`, `aria-pressed`, `aria-current`, `aria-sort`).
- Erreurs : sous le champ (`aria-describedby`) + récapitulatif focalisé après envoi refusé.
- Annonces : `aria-live="polite"` pour succès et progression, `role="alert"` pour les erreurs.
- `prefers-reduced-motion` respecté ; animations CSS sur `opacity`/`transform` seulement.

## Alpine.js (ADR-0011)

- Build CSP uniquement (`@alpinejs/csp`). Logique dans `src/web/client/components/*.ts`
  (`Alpine.data`), enregistrée dans `src/web/client/main.ts` ; esbuild -> `static/app.js`.
- Dans le TSX : noms simples seulement, `x-data="nomComposant"`, `x-on:click="toggle"`,
  `x-show="open"`, `x-text="count"`, `x-bind:aria-expanded="open"`, `x-for="item in items"`.
  Pas d'objet littéral, d'opérateur, d'appel avec arguments ni d'affectation dans un attribut
  (seule tolérance : `!` devant un nom). Syntaxe longue obligatoire (`x-on:`, `x-bind:`), les
  raccourcis `@`/`:` n'étant pas du JSX valide.
- Interdits : `x-html`, `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write` dans `client/`,
  `fetch` direct (les échanges serveur passent par htmx, qui porte le jeton CSRF), stockage de
  secrets ou de données sensibles côté client, `localStorage` hors préférences d'affichage.
- Paramètres d'un composant : attributs `data-*` lus dans `init()` (chaînes échappées par TSX).
- Une cible htmx ne remplace pas la racine d'un composant Alpine dont l'état doit survivre.
- Toute page doit rester utilisable sans JavaScript pour les actions essentielles (formulaires POST).

## Avant de livrer

Parcourir la liste de contrôle de `docs/12` §12 ; Playwright + axe sans violation, aucune violation CSP.
