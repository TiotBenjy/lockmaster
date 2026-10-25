# 07 : Interface web

Rendu serveur TSX + htmx (ADR-0004) + réactivité locale par composants **Alpine.js build CSP**
(ADR-0011). Objectif : chaque page <= ~250 lignes, composants partagés dans `src/web/components/`.
Apparence, composants, états et accessibilité : **`docs/12-systeme-de-design.md`** (normatif) ;
règles d'application : `.claude/rules/ui.md` ; référentiel UX : skill `ui-ux-pro-max`.

## Pages

| Page | Contenu |
|---|---|
| `/login`, `/login/mfa`, `/password/reset` | + bouton OIDC |
| `/` Tableau de bord | compteurs par état, file de revue, CVE KEV publiés, santé des bases, derniers événements |
| `/repos/:repo` + `/repos/:repo/upload` | liste filtrable (canal, état, nom), upload avec progression SSE |
| `/packages/:id` | métadonnées, dépendances, scans, findings, décisions, canaux, historique d'audit |
| `/review` File de revue, `/vulns` Vulnérabilités | décision + justification + waiver ; vue par CVE (quels paquets) |
| `/promotions` | demandes en attente, approbation 4 yeux |
| `/admin/repos` | dépôts, canaux, archs, mode de signature, public/privé, identifiants clients (secret affiché une fois) |
| `/sources`, `/sources/:id/search` | sources amont, recherche FTS dans l'index, import avec résolution de dépendances (aperçu de la liste avant import) |
| `/repos/:repo/setup` | snippets apt (deb822 + auth.conf), dnf (.repo), apk ; variante Dockerfile ; URL = `public_url` du serveur de dépôt (cible principale), jamais l'URL de l'app |
| `/admin/users`, `/admin/groups`, `/admin/directory` | comptes (source locale/annuaire, dernière synchro, droits effectifs avec le groupe d'origine de chaque rôle), jetons ; **groupes locaux** (membres, rôles, marqueur « secours ») ; **groupes d'annuaire** : mapping groupe AD/OIDC -> rôle global ou par dépôt (recherche du groupe dans l'annuaire, aperçu des membres) ; état des connecteurs (dernier succès, âge du cache vs `max_staleness`, bouton « synchroniser ») ; bandeau « connexion de secours » (ADR-0010) ; changements `admin`/`maintainer` soumis aux 4 yeux |
| `/audit` | recherche, filtres, export JSONL/CSV, bouton « vérifier la chaîne » |
| `/stats` | téléchargements par jour/dépôt/paquet |
| `/admin/health` | clamd, grype, âge des bases, clés (expiration), disque, jobs, **cibles de publication** (génération active par canal, retard, dernière vérification HTTP, dérive, bouton « resynchroniser ») |
| `/admin/settings` | politique (éditeur YAML validé + aperçu « que se passerait-il sur le catalogue actuel »), rétention, planifications, notifications, clés |
| `/me` | profil, MFA, sessions actives, jetons personnels |
| `/jobs/:id` | progression SSE d'un job (import, miroir, publication) |

## Règles

- Mise en page : `Layout` avec navigation selon les permissions (on n'affiche pas ce qu'on ne
  peut pas faire ; le serveur vérifie de toute façon).
- Formulaires : POST classiques améliorés par htmx (`hx-post`, `hx-target`) ; fonctionnent aussi
  sans JS. Champ caché `_csrf` + en-tête `X-CSRF-Token`. Validation à la sortie du champ par
  `formValidation` (confort), le serveur reste juge ; erreurs selon `docs/12` §6.
- Tables : pagination serveur (curseur), tri et filtres en query string (URL partageable).
- Confirmation des actions destructrices : fragment de confirmation serveur chargé par htmx dans un
  `<dialog>` piloté par `confirmDialog` (page de confirmation sans JS ; pas de `confirm()`), qui
  rappelle la cible exacte ; saisie du nom pour les actions irréversibles.
- Messages flash via cookie signé de courte durée.
- Accessibilité : WCAG 2.2 AA (`docs/12`), vérifiée par axe en Playwright sur chaque page.
- Langue : français (chaînes dans `src/web/i18n/fr.ts`, structure prête pour `en`).
- Aucun contenu de paquet (description, changelog, scripts) n'est rendu autrement qu'en texte
  échappé, dans des `<pre>` pour les scripts, tronqué au-delà de 64 KiB.

## Composants de base

`Layout`, `Nav`, `Table` (tri/pagination), `Pager`, `Badge` (état/sévérité), `FindingList`,
`DecisionForm`, `ConfirmDialog` (fragment), `Flash`, `JobProgress` (SSE via extension htmx sse
vendorisée), `CodeBlock` (snippets copiables), `SecretOnce`, `Time`, `EmptyState`, `Skeleton`,
`SeverityBadge`, `StateBadge`, `IconButton`. Spécification de chacun : `docs/12` §6.

## Réactivité locale (Alpine.js build CSP, ADR-0011)

Répartition : **htmx** pour tout ce qui lit ou modifie l'état serveur (fragments, pagination, SSE) ;
**Alpine** pour l'état d'affichage local, instantané et éphémère. Aucun appel réseau depuis Alpine.

| Composant (`src/web/client/components/`) | Où | Comportement |
|---|---|---|
| `navDisclosure` | `Layout` < 1024 px | ouvre/ferme la navigation, `aria-expanded`, `Échap` |
| `menu` | actions de ligne, compte | menu déroulant clavier (flèches, `Échap`, clic extérieur) |
| `tabs` | détail paquet, réglages | motif ARIA tabs, onglet reflété dans l'URL (`history.replaceState`) |
| `listFilter` | listes déjà rendues (canaux, archs, CVE d'un paquet) | filtre instantané côté client avec compteur annoncé ; les grandes listes restent filtrées côté serveur (query string) |
| `bulkSelect` | file de revue, promotions | sélection multiple, barre d'actions groupées, compteur |
| `formValidation` | tous les formulaires | validation à la sortie du champ, récapitulatif d'erreurs focalisé |
| `confirmDialog` | actions destructrices | `<dialog>` modal, focus piégé et restitué, saisie de confirmation |
| `copyButton` | `CodeBlock`, empreintes, `requestId` | copie dans le presse-papiers, retour « Copié » annoncé |
| `secretOnce` | jetons, identifiants clients | impose la case « J'ai enregistré ce secret » avant fermeture |
| `themeToggle` | `/me`, en-tête | clair/sombre/système (cookie `lockmaster_theme`, non sensible) |
| `flashQueue` | `Layout` | file de notifications, pause au survol/focus, erreurs persistantes |
| `relativeTime` | `Time` | met à jour « il y a 3 min » sans requête |

Chaque composant est une fabrique typée testée en unitaire (vitest, happy-dom si besoin) **avant**
d'être écrite (TDD), puis couverte par un parcours Playwright quand elle intervient dans un flux
critique. Le TSX ne référence que des noms (`x-data="bulkSelect"`, `x-on:click="toggleAll"`) ; la
liste des noms valides est un type (`AlpineComponentName`).
