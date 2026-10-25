---
paths:
  - "src/signer/**"
  - "src/signer-client/**"
---

# Règles pour le service de signature (ADR-0009)

- Lis `docs/adr/0009-processus-signataire-separe.md` avant toute modification.
- `src/signer/` est un **processus séparé** : aucune API réseau (socket Unix uniquement), aucune lecture
  de la base ou des fichiers de l'application, aucune dépendance hors de `openpgp`, `node:crypto`,
  `better-sqlite3`, `zod`, `pino` et des parseurs de `src/formats/`.
- Le socket n'expose que `ping`, `status`, `list-keys`, `generate-key`, `rotate-key`, `retire-key`,
  `sign`, `log`. Aucune opération n'exporte une clé privée ni ne modifie l'identité d'une clé.
- Chaque type de demande a ses contrôles (tableau d'ADR-0009) ; un refus est journalisé comme une
  signature. Toute nouvelle opération ou tout nouveau type de demande exige un ADR.
- `src/signer-client/` est la seule voie pour obtenir une signature ; le reste de l'application ne
  l'importe que via son interface publique et n'importe jamais `src/signer/`.
- Objectif de taille : `src/signer/` < 1 500 lignes (hors parseurs partagés). Revue `security-reviewer`
  obligatoire.
