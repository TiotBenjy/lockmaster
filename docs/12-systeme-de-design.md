# 12 : Système de design de l'interface

Référence normative pour tout ce qui se voit dans l'UI (`src/web/`). Contraintes techniques :
ADR-0004 (rendu serveur, CSP stricte) et ADR-0011 (Alpine.js build CSP). Règles d'application :
`.claude/rules/ui.md`. Référentiel de règles UX/accessibilité : skill `ui-ux-pro-max`
(`.claude/skills/ui-ux-pro-max/`, `references/quick-reference.md`), interrogé avec
`--domain ux|color|icons|chart|typography` : jamais `--stack` ni `--persist`.

Objectif : une **console d'administration professionnelle**, sobre, dense, lisible, prévisible,
accessible (WCAG 2.2 AA), identique en clair et en sombre. Ce n'est pas un site marketing :
pas de héros, pas de dégradés décoratifs, pas d'animation d'agrément.

## 1. Direction retenue

Issue de `search.py "security operations admin dashboard package repository" --design-system
--density 8 --variance 2 --motion 2` (2026-10-25), puis adaptée :

| Réglage | Valeur | Conséquence |
|---|---|---|
| Style | Minimalism & Swiss Style | grille, typographie claire, contraste élevé, peu d'effets |
| Densité | 8/10 (tableau de bord) | échelle d'espacement 4-32 px, tableaux compacts |
| Variance | 2/10 | mise en page centrée et régulière, aucune asymétrie décorative |
| Mouvement | 2/10 | micro-transitions CSS uniquement |

Écarts assumés par rapport à la sortie brute du skill :
- **Polices** : la sortie brute propose Fira Sans/Fira Code **via Google Fonts** ; le chargement depuis
  Google est refusé (fuite d'adresse IP vers un tiers, dépendance réseau incompatible avec l'air-gap,
  CSP). On retient l'appariement « Minimal Swiss » du même skill : **Inter**, complétée par
  **JetBrains Mono** pour les données techniques, **auto-hébergées** (`src/web/static/fonts/`,
  `font-src 'self'`) : §3.
- **Couleur d'action** : le vert proposé comme couleur d'appel à l'action entre en conflit avec le
  vert sémantique « approuvé/sain ». L'action principale est **bleue** ; le vert est réservé aux états.
- **Mouvement** : l'extrait GSAP proposé est écarté (aucune bibliothèque d'animation) ; seules des
  transitions CSS sont permises (§8).
- **Motif « Operations Landing »** (héros, CTA) : sans objet pour une console authentifiée.

## 2. Couleurs (jetons sémantiques)

Définies une seule fois dans `src/web/static/app.css` sous forme de variables CSS ; **aucune couleur
littérale ailleurs** (ni dans les composants, ni dans d'autres règles CSS). Thème selon
`prefers-color-scheme`, surchargeable par l'utilisateur (`/me` -> cookie non sensible
`lockmaster_theme=light|dark|system`, rendu côté serveur dans `<html data-theme>` pour éviter le flash).

| Jeton | Clair | Sombre | Usage |
|---|---|---|---|
| `--bg` | `#F8FAFC` | `#0F172A` | fond de page |
| `--surface` | `#FFFFFF` | `#1B2336` | cartes, tableaux, formulaires |
| `--surface-2` | `#F1F5F9` | `#272F42` | en-têtes de tableau, zones secondaires |
| `--text` | `#0F172A` | `#F8FAFC` | texte principal |
| `--text-muted` | `#475569` | `#94A3B8` (`#A3B1C6` sur `--surface-2`) | texte secondaire |
| `--divider` | `#E2E8F0` | `#334155` | séparateurs décoratifs uniquement |
| `--control-border` | `#64748B` | `#64748B` | bordures de champs et contrôles (>= 3:1) |
| `--primary` / `--on-primary` | `#1D4ED8` / `#FFFFFF` | `#60A5FA` / `#0F172A` | action principale, liens |
| `--focus` | `#2563EB` | `#93C5FD` | anneau de focus |
| `--danger` / `--on-danger` | `#B91C1C` / `#FFFFFF` | `#F87171` / `#0F172A` | actions destructrices |

États (badge = fond + texte + **icône + libellé**, jamais la couleur seule) :

| Jeton | Clair (texte / fond) | Sombre (texte / fond) | États Lockmaster |
|---|---|---|---|
| `--ok-*` | `#166534` / `#DCFCE7` | `#86EFAC` / `#14532D` | `approved`, `published`, sain |
| `--warn-*` | `#854D0E` / `#FEF9C3` | `#FDE047` / `#422006` | `pending_review`, `warn`, données périmées |
| `--danger-*` | `#991B1B` / `#FEE2E2` | `#FCA5A5` / `#450A0A` | `rejected`, `blocked`, `error`, dérive |
| `--info-*` | `#1E40AF` / `#DBEAFE` | `#BFDBFE` / `#1E3A8A` | `scanning`, job en cours |
| `--neutral-*` | `#334155` / `#E2E8F0` | `#E2E8F0` / `#334155` | `uploaded`, retiré, inactif |

Sévérités CVE (badge plein, libellé toujours écrit : « Critique », « Haute »...) :

| Sévérité | Clair (texte / fond) | Sombre (texte / fond) |
|---|---|---|
| critique | `#FFFFFF` / `#7F1D1D` | `#0F172A` / `#FCA5A5` |
| haute | `#FFFFFF` / `#B91C1C` | `#0F172A` / `#F87171` |
| moyenne | `#FFFFFF` / `#9A3412` | `#0F172A` / `#FDBA74` |
| basse | `#FFFFFF` / `#1E40AF` | `#0F172A` / `#93C5FD` |
| négligeable / inconnue | `#FFFFFF` / `#475569` | `#0F172A` / `#CBD5E1` |

KEV et EPSS élevé : badge supplémentaire avec icône dédiée (`warning-octagon`) et libellé « KEV ».

Contrastes vérifiés le 2026-10-25 (WCAG 2.x) : toutes les paires texte >= 4,5:1 (minimum mesuré
6,1:1), bordures de contrôle et focus >= 3:1 (minimum 3,29:1, `--control-border` sur `--surface`
sombre). Ce calcul devient un **test** (§12).

## 3. Typographie

Polices fournies dans le kit (`src/web/static/fonts/` : fichiers `woff2` variables, `fonts.css`,
licences OFL, `SHA256SUMS`, provenance dans `README.md`) :

- Texte : **Inter** 4.001 (`--font-sans`), repli `system-ui, "Segoe UI", Roboto, "Noto Sans",
  "Liberation Sans", sans-serif`. Dessinée pour l'écran aux petites tailles, chiffres tabulaires,
  rendu identique sur tous les OS.
- Code, versions, sha256, empreintes, identifiants CVE, snippets : **JetBrains Mono** 2.211
  (`--font-mono`), ligatures désactivées ; `0`/`O` et `1`/`l`/`I` sans ambiguïté.
- `font-display: swap`, sous-ensembles `latin` + `latin-ext` chargés à la demande (`unicode-range`) ;
  `<link rel="preload">` seulement pour `inter-latin-wght-normal.woff2` (seule police critique).
- Échelle (rem, base 16 px) : 0,75 (12 px, plancher absolu, métadonnées) · 0,875 (14 px, cellules de
  tableau, aide) · **1 (16 px, texte courant, champs)** · 1,125 · 1,25 · 1,5 · 1,875 (titre de page).
- Graisses : 400 texte, 500 libellés, 600 titres. Interlignage 1,5 (texte), 1,25 (titres, cellules).
- Chiffres tabulaires (`font-variant-numeric: tabular-nums`) dans les tableaux, compteurs, tailles, dates.
- Longueur de ligne du texte courant <= 72 ch ; titres courts en `text-wrap: balance`.
- Hash, URL, empreintes : `overflow-wrap: anywhere` dans un enfant rétrécissable ; empreinte OpenPGP
  affichée **en entier**, groupée par 4 caractères, avec bouton « Copier ».

## 4. Espacement, formes, profondeur

- Espacement (densité 8) : `--space-1` 4 px · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 24 · `-6` 32.
- Rayons : 4 px (badges, champs), 6 px (boutons), 8 px (cartes, dialogues). Pas de formes « pilule »
  hors badges.
- Ombres : deux niveaux seulement (`--shadow-1` cartes, `--shadow-2` menus et dialogues) ; en sombre,
  la profondeur vient de `--surface`/`--surface-2`, pas de l'ombre.
- Couches (`z-index`) : 0 contenu · 10 en-têtes collants · 20 menus · 40 bandeaux · 100 dialogues ·
  1000 notifications.

## 5. Mise en page et navigation

- Structure : lien d'évitement « Aller au contenu » -> `header` (nom de l'instance, recherche, compte)
  -> `nav` -> `main` (un seul `h1`) ; repères ARIA natifs.
- >= 1024 px : barre latérale de navigation fixe (240 px) ; < 1024 px : barre supérieure et menu en
  divulgation (`navDisclosure`). Mêmes entrées, même ordre partout ; entrée active marquée
  (`aria-current="page"` + indicateur visuel, pas seulement la couleur).
- Points de rupture : 375 · 768 · 1024 · 1440 px ; conception mobile d'abord ; zoom jamais bloqué ;
  aucun défilement horizontal de page (les tableaux larges défilent dans leur propre conteneur
  focalisable, `role="region"` + `aria-label`).
- Fil d'Ariane dès 3 niveaux (Dépôt › Paquet › Analyse). Toute vue est accessible par une URL
  (filtres, tri, onglet et page en query string) ; le bouton « retour » du navigateur restaure l'état.
- Une seule **action principale** par écran ; actions destructrices séparées visuellement et
  spatialement (zone « Zone dangereuse » en bas des pages d'administration).
- Bandeaux globaux (en haut de `main`, `role="status"` ou `role="alert"`) : connexion de secours
  (ADR-0010), annuaire injoignable ou cache proche de `max_staleness`, bases de vulnérabilités
  périmées, cible de publication en dérive, clé de signature proche de l'expiration.

## 6. Composants

Tous dans `src/web/components/`, un fichier par composant, propriétés typées ; la réactivité locale
éventuelle est un composant Alpine nommé (ADR-0011).

| Composant | Règles |
|---|---|
| `Button` | variantes `primary`, `secondary`, `danger`, `ghost` ; hauteur 36 px (cible >= 24x24 px CSS, 44 px sous `@media (pointer: coarse)`) ; `cursor: pointer` ; états survol/actif/focus/désactivé distincts ; pendant une requête htmx : `aria-busy="true"`, désactivé, indicateur, libellé conservé |
| `IconButton` | `aria-label` obligatoire (vérifié par le type) + infobulle au focus et au survol |
| `Badge`, `SeverityBadge`, `StateBadge` | icône (`aria-hidden`) + libellé texte ; couleurs des §2 |
| `Table` | en-tête collant ; tri serveur avec `aria-sort` ; colonnes numériques alignées à droite ; actions de ligne regroupées dans un menu « Plus » au-delà de deux ; sélection multiple + barre d'actions groupées pour la file de revue ; état vide avec explication et action ; pagination par curseur (`Pager`) ; jamais de tableau rendu côté client |
| `Field`, `Form` | libellé visible (`<label for>`) ; marque « obligatoire » ; aide persistante sous le champ ; erreur sous le champ reliée par `aria-describedby` ; validation à la sortie du champ (`formValidation`), pas à chaque frappe ; après un envoi refusé : **récapitulatif d'erreurs** focalisé en haut avec liens vers les champs, erreurs de champ conservées ; `autocomplete` correct (`username`, `current-password`, `new-password`, `one-time-code`) ; coller autorisé partout, gestionnaires de mots de passe compatibles ; `inputmode="numeric"` pour le TOTP ; lecture seule distincte de désactivé |
| `ConfirmDialog` | fragment serveur affiché dans `<dialog>` (`confirmDialog`) : rappelle la cible exacte (dépôt, paquet, version, empreinte de clé) ; focus piégé, `Échap` ferme, focus rendu au déclencheur ; saisie du nom exigée pour les actions irréversibles (supprimer un dépôt, retirer une clé, rotation d'urgence) ; sans JS : page de confirmation |
| `Flash`, notifications | `aria-live="polite"`, ne volent pas le focus ; succès effacé après 5 s (pause au survol/focus) ; **erreurs persistantes** jusqu'à fermeture, `role="alert"`, avec cause + action de reprise |
| `Tabs` | motif ARIA « tabs » (flèches, `Home`/`End`), onglet actif dans l'URL (`tabs`) |
| `Menu`, divulgation | bouton avec `aria-expanded` / `aria-controls`, fermeture par `Échap` et clic extérieur |
| `CodeBlock` | snippets client (apt/dnf/apk) en `<pre><code>`, bouton « Copier » (`copyButton`) avec retour « Copié » annoncé |
| `SecretOnce` | secret affiché une seule fois (jeton d'API, identifiant client) : champ en lecture seule, « Copier », case « J'ai enregistré ce secret » requise pour fermer, avertissement explicite |
| `JobProgress` | SSE ; `role="progressbar"` avec `aria-valuenow` et texte (« 42 / 120 paquets analysés ») ; erreur avec bouton « Réessayer » |
| `Time` | `<time datetime>` ; date absolue (« 25 oct. 2026, 14:03 ») avec relatif en infobulle, `Intl` `fr-FR` |
| `Skeleton` | uniquement pour un chargement > 1 s ; espace réservé à la taille finale (pas de saut de mise en page) |
| `EmptyState` | phrase d'explication + action utile (« Aucun paquet. Configurer la CI » -> `/repos/:repo/setup`) |

Contenu issu des paquets (description, changelog, scripts) : texte échappé, `<pre>` pour les scripts,
tronqué à 64 KiB avec mention « tronqué » (ADR-0004, invariant 10).

## 7. Icônes

- Une seule famille : **Phosphor**, graisse `regular` (MIT), recommandée par le skill. Pas d'emoji
  comme icône, pas d'icône raster.
- Les SVG d'une **liste blanche** (`src/web/icons/list.ts`) sont extraits du paquet de développement
  `@phosphor-icons/core` par `scripts/build-icons.mjs` en composants TSX (`src/web/icons/generated.tsx`,
  commité, régénéré et comparé en CI) : SVG en ligne, aucun sprite externe, aucune requête.
- Tailles en jetons : 16 px (dans le texte, tableaux), 20 px (boutons), 24 px (navigation) ;
  `currentColor`, alignées sur la ligne de base.
- Sémantique selon l'usage : décorative à côté d'un libellé -> `aria-hidden="true"` ; seule et
  porteuse de sens -> texte alternatif ; dans un bouton -> nom accessible sur le bouton.

## 8. Mouvement

- Transitions CSS uniquement, sur `opacity` et `transform` : `--motion-fast` 120 ms (survol, appui),
  `--motion-base` 200 ms (menus, dialogues) ; entrée en décélération, sortie ~70 % de l'entrée.
- Une animation exprime une cause (ouverture, apparition d'un résultat), jamais une décoration ;
  aucune animation ne bloque une saisie.
- `@media (prefers-reduced-motion: reduce)` : durées à 0, aucun clignotement ; l'indicateur « en
  direct » d'un job devient statique.

## 9. Données et graphiques

- Page `/stats` et vignettes du tableau de bord : graphiques **SVG générés côté serveur** en TSX
  (barres pour comparer, lignes pour une tendance), sans bibliothèque ni JS.
- Toujours : titre, axes avec unités, légende proche, valeurs exactes accessibles (infobulle au focus
  et au survol), **tableau équivalent** (« Voir les données ») et résumé textuel (`aria-label` / `<desc>`) ;
  séries distinguées aussi par motif ou forme, jamais rouge/vert seuls ; nombres et dates `fr-FR`.
- État vide (« Aucune donnée sur la période ») et état d'erreur (cause + « Réessayer »), jamais un
  cadre d'axes vide.

## 10. Écrans de sécurité

- Empreintes de clés et sha256 toujours affichés en entier là où une décision en dépend (revue,
  configuration client, rotation).
- File de revue : demandeur, date, justification et **qui peut approuver** (4 yeux : le bouton
  « Approuver » est absent pour le demandeur, avec l'explication à la place).
- Fraîcheur visible : âge des bases ClamAV/Grype/KEV/EPSS, dernière synchronisation de l'annuaire,
  dernière vérification de chaque cible : en `--warn` au-delà du seuil, en `--danger` au-delà de la
  limite de blocage.
- Erreurs : jamais de pile ni de chemin ; message, action, `requestId` copiable.

## 11. Rédaction

- Français, vouvoiement, phrases courtes, verbes d'action sur les boutons (« Approuver la version
  1.2.3 », pas « OK »). Termes constants (glossaire dans `src/web/i18n/fr.ts`).
- Typographie française sobre : guillemets « », apostrophe droite, espace insécable ordinaire
  (U+00A0) avant `: ; ! ?` et entre un nombre et son unité (« 12 Mo »), dans `src/web/i18n/fr.ts`
  uniquement. Aucun tic typographique d'IA (tiret long, points de suspension en un seul caractère, flèches, emoji) :
  CLAUDE.md §Style d'écriture.
- Messages d'erreur : cause + correction (« Le fichier dépasse 512 Mo, la limite de ce dépôt. »).

## 12. Vérification (TDD et pré-livraison)

Tests (écrits avant le code concerné, `docs/10`) :
- `test/web/fonts.test.ts` : sha256 de chaque `.woff2` = `SHA256SUMS` ; `fonts.css` ne référence
  que des fichiers locaux existants.
- `test/web/design-tokens.test.ts` : lit les variables de `static/app.css` pour les deux thèmes et
  calcule les contrastes des paires des §2 (texte >= 4,5:1, contrôles et focus >= 3:1) ; échoue sur
  toute couleur littérale hors du bloc de jetons.
- Tests de rendu (`app.inject`) : un `h1` par page, libellé pour chaque champ, `aria-label` des boutons
  icônes, aucun attribut `style=`/`on*=`/`x-html`.
- Playwright (`test/e2e/ui/`) : chaque page à 375, 768 et 1280 px en clair et en sombre, avec
  `@axe-core/playwright` (zéro violation de niveau A/AA) et **zéro violation CSP**
  (écoute de `securitypolicyviolation`) ; parcours clavier complets (connexion + MFA, upload, revue
  4 yeux, confirmation destructive) ; `prefers-reduced-motion` activé.

Liste de contrôle avant de livrer un écran (adaptée de `references/pro-rules.md` au web) :
- [ ] Recherches du skill limitées au besoin (ex. `"error summary validation" --domain ux`) ;
      `quick-reference.md` §1-§3 relus.
- [ ] Jetons uniquement (couleurs, `--font-sans`/`--font-mono`) ; clair et sombre vérifiés séparément ; contrastes AA.
- [ ] Focus visible partout, ordre de tabulation = ordre visuel, rien de masqué par un élément collant.
- [ ] Cibles >= 24x24 px (44 px en pointeur grossier) ; espacement >= 8 px entre cibles.
- [ ] Icônes Phosphor uniquement, sémantique correcte ; aucune information portée par la couleur seule.
- [ ] Formulaires : libellés, aide, erreurs sous les champs + récapitulatif, états de chargement.
- [ ] États vide, chargement, erreur, succès traités.
- [ ] 375 px sans défilement horizontal ; zoom 200 % utilisable.
- [ ] `prefers-reduced-motion` respecté ; aucune animation décorative.
- [ ] Aucune violation CSP ; aucun `style=`, `on*=`, `x-html`, expression Alpine complexe.
