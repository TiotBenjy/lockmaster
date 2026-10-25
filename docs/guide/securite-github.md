# Sécurité du dépôt GitHub

Ces réglages ne sont pas dans le code : ils se font dans les paramètres du dépôt
`github.com/TiotBenjy/lockmaster`, par son propriétaire. Ils complètent les workflows de
`.github/workflows/` et `.github/CODEOWNERS` (SEC-19, SEC-24). Les intitulés des menus peuvent varier
selon l'interface de GitHub ; les réglages, eux, sont stables.

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

## 5. Protection de la branche principale

Règle (ruleset) sur `main`, et de préférence sur `dev` :
- PR obligatoire, au moins une approbation, **revue des propriétaires du code obligatoire**
  (`.github/CODEOWNERS` : TiotBenjy) ;
- approbations annulées à chaque nouveau commit ;
- vérifications obligatoires : les jobs de `CI` (« Vérifications et tests », « Configurations de
  déploiement », « Paquets et image », les tests de livrables), « CodeQL » et « Revue des
  dépendances » ;
- branche à jour avant fusion, pas de `force push`, pas de suppression ;
- le propriétaire ne contourne pas la règle (pas d'exception « bypass » pour les administrateurs).

## 6. Actions GitHub

Settings, section Actions :
- autoriser seulement les actions de GitHub et les actions vérifiées, et **exiger l'épinglage par
  SHA de commit** (option « Require actions to be pinned to a full-length commit SHA ») ; les
  workflows le font déjà (test `test/security/SEC-24-supply-chain.test.ts`) ;
- permissions par défaut du `GITHUB_TOKEN` : **lecture seule** ;
- interdire aux actions de créer ou d'approuver des PR ;
- PR venant de forks : approbation requise avant l'exécution des workflows.

## 7. Publication de l'image (ghcr.io)

- **Environnement `release`** (Settings, Environments) : relecteur obligatoire (TiotBenjy), et
  déploiement limité aux tags `v*`. Seul `.github/workflows/release.yml` y entre ; c'est le seul job
  qui peut écrire dans le registre (`packages: write`).
- Paquet `ghcr.io/tiotbenjy/lockmaster` : visibilité publique, lié au dépôt, accès en écriture
  réservé aux workflows de ce dépôt.
- Publier une version : mettre à jour `version` dans `package.json`, fusionner, puis pousser le tag
  `vX.Y.Z` correspondant (le workflow vérifie la concordance) et approuver le déploiement.
- Signature cosign et SBOM des images : jalon M10.
