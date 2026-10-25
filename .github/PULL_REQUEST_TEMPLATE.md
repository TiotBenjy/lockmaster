## Objet

<!-- Ce que change cette PR et pourquoi. Lien vers l'issue : « Corrige #123 ». -->

## Type

- [ ] Correctif (`fix`)
- [ ] Fonctionnalité (`feat`)
- [ ] Sécurité (`sec`)
- [ ] Refactoring sans changement de comportement (`refactor`)
- [ ] Documentation, tests, build ou CI

## Vérifications

- [ ] Tests écrits **avant** le code (TDD) ; un correctif commence par un test qui reproduit le bogue.
- [ ] `pnpm check` et `pnpm test` passent ; `pnpm test:e2e` aussi si formats, publication, import ou livraison sont touchés.
- [ ] Aucun invariant de sécurité de `CLAUDE.md` n'est affaibli ; revue `security-reviewer` faite pour les zones sensibles.
- [ ] Toute décision d'architecture nouvelle a son ADR (`docs/adr/`).
- [ ] Documentation à jour (`docs/`), y compris la feuille de route si un critère est atteint.
- [ ] Toute nouvelle dépendance est justifiée (alternative native, maintenance, dépendances transitives) et sous licence compatible MIT.
- [ ] Pour l'interface : liste de contrôle de `docs/12` §12 passée (accessibilité, CSP, clair et sombre).
- [ ] Style d'écriture respecté (`CLAUDE.md` §Style d'écriture) ; aucun secret ni donnée réelle.

## Notes pour la relecture

<!-- Points d'attention, captures d'écran pour l'UI, limites connues. -->
