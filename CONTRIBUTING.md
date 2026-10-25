# Contribuer à Lockmaster

Merci de votre intérêt. Ce guide s'adresse aux contributeurs humains ; les règles détaillées, qui
valent aussi pour eux, sont dans `CLAUDE.md` (stack, invariants de sécurité, conventions).

## Avant de commencer

- **Sécurité** : une vulnérabilité se signale en privé (`SECURITY.md`), jamais par une issue ou une PR.
- Pour une évolution notable, ouvrez d'abord une issue « Demande de fonctionnalité » : si elle
  change la stack, le périmètre, la sécurité ou la livraison, elle passera par un ADR (`docs/adr/`).
- Lisez le document du domaine que vous touchez (`docs/00` à `docs/12`).

## Environnement

Node.js 24 LTS, pnpm 12 (version épinglée par `packageManager`), Docker ou Podman (tests e2e), Python 3 (outil de recherche du skill UI, en
développement seulement). Travaillez dans une VM ou un conteneur jetable, sans vrai secret.

```bash
pnpm install --frozen-lockfile
pnpm dev:init      # configuration et données de développement jetables
pnpm dev
pnpm check         # Biome + TypeScript + règles de couches
pnpm test          # unitaires et intégration
pnpm test:e2e      # vrais clients apt, dnf, apk contre nginx (conteneurs)
```

## Règles de contribution

- **TDD** : le test d'abord, qui échoue pour la bonne raison, puis le code minimal, puis le
  refactoring. Un correctif commence par un test qui reproduit le bogue.
- **SOLID** : une nouvelle implémentation d'interface passe sa suite de conformité
  (`test/contracts/`). Respect des règles de couches (`docs/01` §6).
- **Invariants de sécurité** (`CLAUDE.md`) : aucun n'est négociable. Ne désactivez jamais un contrôle
  pour faire passer un test.
- **Dépendances** : chaque ajout est justifié dans le commit (alternative native, maintenance,
  dépendances transitives) et sous licence compatible MIT (`CLAUDE.md` §Licence).
- **Interface** : `docs/12-systeme-de-design.md` et sa liste de contrôle (WCAG 2.2 AA, CSP stricte,
  clair et sombre).
- **Style d'écriture** : français simple, sans tiret long, sans points de suspension en un seul
  caractère, sans flèches ni emoji (`CLAUDE.md` §Style d'écriture). Identifiants de code en anglais.

## Commits et pull requests

- Messages au format conventionnel, en français : `feat(rpm): signe les paquets en mode resign`,
  `fix(auth): refuse un jeton expiré`, `sec(publish): ...`, `docs: ...`, `test: ...`.
- Une PR = un sujet. Remplissez le modèle de PR ; la CI doit être verte.
- Les fichiers sensibles (`.claude/`, `.github/`, `test/security/`, code de sécurité) exigent la
  relecture des propriétaires (`CODEOWNERS`).

## Développement avec Claude Code

Le dépôt contient la configuration de Claude Code (`.claude/`) : l'agent travaille dans des worktrees,
committe localement, ne pousse jamais, et ses garde-fous (hooks) appliquent les mêmes règles que
la CI. Toute modification de `.claude/` est faite par un humain et relue par l'équipe sécurité.

## Licence

En contribuant, vous acceptez que votre contribution soit publiée sous la licence MIT du projet
(`LICENSE`).
