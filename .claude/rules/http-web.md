---
paths:
  - "src/http/**"
  - "src/web/**"
---

# Règles pour HTTP et l'interface web

- Chaque route déclare `config.perm` (+ `repoParam` si portée dépôt) ou `config.public: true`.
  Le contrôle d'accès est fait côté serveur, y compris pour les fragments htmx.
- Validation de toute entrée (params, query, body, en-têtes utilisés) par un schéma zod.
- `/api/v1` : jeton Bearer uniquement, cookies ignorés. UI : cookie de session + jeton CSRF sur
  toute requête non-GET. Pas de CORS.
- Les routes et handlers n'accèdent pas à la base : ils appellent les services.
- Pages TSX <= ~250 lignes ; composants dans `src/web/components/`. Aucun `dangerouslySetInnerHTML`,
  aucun attribut `on*`, aucun `style=` inline, aucun `<script>` inline (CSP).
- Le contenu provenant des paquets (description, changelog, scripts) est affiché comme texte
  échappé, tronqué à 64 KiB.
- Les erreurs renvoyées au client n'exposent ni pile, ni chemin, ni SQL ; seulement `code`,
  `message`, `requestId`.
- L'application ne sert **aucun** fichier de dépôt (ADR-0008) : pas de route `/apt`, `/rpm`, `/apk`,
  `/snapshots`, pas de `@fastify/static` sur des données de paquets. Seul le téléchargement
  d'administration `/api/v1/packages/:id/download` (authentifié, `attachment`) existe.
