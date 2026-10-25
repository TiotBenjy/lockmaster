---
paths:
  - "src/crypto/**"
  - "src/auth/**"
  - "src/pipeline/**"
  - "src/scan/**"
  - "src/upstream/**"
  - "src/storage/**"
  - "src/net/**"
  - "src/publish/**"
  - "src/stats/**"
  - "src/signer/**"
  - "src/signer-client/**"
  - "packaging/systemd/**"
  - "deploy/quadlet/**"
  - "deploy/nginx/**"
---

# Règles pour le code sensible

- Relis `docs/02-securite.md` (sections pertinentes) avant de modifier ce code.
- Fail-closed : tout `catch`, timeout ou réponse inattendue mène à un état non publiable ou à un
  refus d'accès. Pas de valeur par défaut permissive, pas d'option pour désactiver un contrôle.
- Aléa : `crypto.randomBytes` / `randomInt` uniquement. Comparaisons de secrets : `timingSafeEqual`
  sur des tampons de même longueur (comparer des hash).
- Aucun secret, jeton, mot de passe, clé ou contenu de paquet dans les logs, les erreurs ou l'audit
  (l'audit enregistre des identifiants et des empreintes, pas des secrets).
- Toute mutation d'état écrit son entrée d'audit dans la même transaction (`db.tx`).
- Sous-processus (grype seulement) : `execFile` avec chemin absolu, tableau d'arguments,
  `shell:false`, timeout, `AbortSignal`, environnement explicite, sortie bornée.
- Réseau sortant (`upstream/`, `notify/`, `scan/` pour les flux) : uniquement via `src/net/`
  (garde SSRF, pas de redirection inter-hôtes, taille et durée bornées, TLS vérifié).
- Tests négatifs obligatoires dans le même commit ; puis revue par l'agent `security-reviewer`.
