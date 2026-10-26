# Sécurité du dépôt GitHub

Ces réglages ne sont pas dans le code : ils se font dans les paramètres du dépôt
`github.com/TiotBenjy/lockmaster`, par son propriétaire. Ils complètent les workflows de
`.github/workflows/` et `.github/CODEOWNERS` (SEC-19, SEC-24). Les intitulés des menus peuvent varier
selon l'interface de GitHub ; les réglages, eux, sont stables.

## 0. Compte du propriétaire

- **Double authentification** obligatoire sur le compte TiotBenjy (clé de sécurité de préférence) :
  ce compte approuve les publications et contourne la règle de branche pour ses PR.
- Jetons personnels : à portée fine, limités à ce dépôt, avec une date d'expiration ; aucun jeton
  classique à portée large.

## 1. Signalement des vulnérabilités

- **Signalement privé de vulnérabilités** (Settings, section sécurité du code) : activé. Les
  chercheurs signalent par un avis de sécurité privé, comme l'indique `SECURITY.md`, et non par une
  issue publique.

## 2. Secrets

- **Analyse des secrets** (secret scanning) : activée.
- **Protection à l'envoi** (push protection) : activée. Un `git push` qui contient un secret reconnu
  est refusé avant d'atteindre GitHub. Ne jamais contourner un refus : retirer le secret de
  l'historique et le révoquer.

## 3. Dépendances

- **Graphe de dépendances** : activé (nécessaire à la revue des dépendances et à Dependabot).
- **Alertes Dependabot** : activées.
- **Mises à jour de sécurité Dependabot** : activées.
- **Mises à jour de versions** : configurées par `.github/dependabot.yml` (npm, actions GitHub), avec
  un délai de 7 jours aligné sur `minimumReleaseAge` de pnpm.
- Une PR de Dependabot se fusionne comme les autres : CI verte et revue du propriétaire.

## 4. Analyse du code

- **CodeQL** : configuration avancée par `.github/workflows/codeql.yml` (requêtes
  `security-extended`). Laisser la configuration par défaut de GitHub **désactivée**, sinon les deux
  analyses entrent en conflit.
- **Revue des dépendances** : `.github/workflows/dependency-review.yml` refuse une PR qui ajoute une
  dépendance vulnérable.

## 5. Protection des branches `main` et `dev`

GitHub interdit à l'auteur d'une PR de l'approuver. Avec un seul propriétaire, une règle qui exige
une approbation sans exception bloquerait toutes ses PR : elle finirait désactivée. Or un acteur de la
liste de contournement d'un ruleset contourne **toutes** les règles de ce ruleset, vérifications
comprises. D'où deux rulesets, chacun sur `main` **et** `dev` :

1. **« Revue »** :
   - PR obligatoire pour toute modification ;
   - une approbation et la **revue des propriétaires du code** (`.github/CODEOWNERS` : TiotBenjy) ;
     approbations annulées à chaque nouveau commit ;
   - liste de contournement : le propriétaire, en mode **« pull requests seulement »** (il fusionne
     ses propres PR sans approbation, jamais par un `push` direct).
2. **« Intégrité »**, **sans aucun contournement** :
   - vérifications obligatoires : les jobs de `CI` (« Vérifications et tests », « Tests e2e »,
     « Configurations de déploiement », « Paquets et image », les tests de livrables), « CodeQL » et
     « Revue des dépendances » ; branche à jour avant fusion ;
   - pas de `force push`, pas de suppression.

Une PR rouge ne peut donc être fusionnée par personne. `release.yml` repasse de plus toutes les
gardes de la CI avant de publier.

Risque résiduel, assumé tant que le projet n'a qu'un mainteneur : une seule personne relit le code
du propriétaire. Les tests de sécurité (`test/security/`, dont le nombre ne peut pas baisser) et la
CI restent le garde-fou ; dès qu'un second mainteneur arrive, retirer le contournement.

## 6. Actions GitHub

Settings, section Actions :
- autoriser seulement les actions de GitHub et les actions vérifiées, et **exiger l'épinglage par
  SHA de commit** (option « Require actions to be pinned to a full-length commit SHA ») ; les
  workflows le font déjà (test `test/security/SEC-24-supply-chain.test.ts`) ;
- permissions par défaut du `GITHUB_TOKEN` : **lecture seule** ;
- interdire aux actions de créer ou d'approuver des PR ;
- PR venant de forks : approbation requise avant l'exécution des workflows.

## 7. Publication de l'image (ghcr.io)

- **Règle de tags** (ruleset sur `v*`) : création réservée au propriétaire, ni mise à jour ni
  suppression. `release.yml` refuse de plus un tag qui n'est pas une version exacte `vX.Y.Z` ou qui
  ne pointe pas sur un commit de `main`.
- **Environnement `release`** (Settings, Environments) : relecteur obligatoire (TiotBenjy),
  déploiement limité aux tags `v*`, et contournement par les administrateurs **décoché**. Ne pas
  cocher « empêcher l'auto-approbation » tant qu'il n'y a qu'un mainteneur : la publication ne
  pourrait jamais être approuvée. Seul `.github/workflows/release.yml` y entre ; c'est le seul job
  qui peut écrire dans le registre (`packages: write`), et il refait les tests et l'essai compose
  de l'image avant de la publier.
- Paquet `ghcr.io/tiotbenjy/lockmaster` : visibilité publique, lié au dépôt, accès en écriture
  réservé aux workflows de ce dépôt.
- Publier une version : mettre à jour `version` dans `package.json`, fusionner, puis pousser le tag
  `vX.Y.Z` correspondant (le workflow vérifie la concordance) et approuver le déploiement.
- Signature cosign et SBOM des images : jalon M10.
