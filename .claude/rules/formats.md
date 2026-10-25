---
paths:
  - "src/formats/**"
  - "src/publish/**"
---

# Règles pour les formats et la publication

- Lis `docs/03-formats.md` avant toute modification. Un détail de format (tag RPM, ordre de champ,
  nom de fichier de signature) se vérifie dans la spécification ou les sources officielles et se
  cite en commentaire ; jamais de mémoire. En cas de doute, délègue à l'agent `formats-expert`.
- Code pur : aucun accès base, réseau ou système de fichiers dans `src/formats/` (entrées :
  `Buffer` / flux ; sorties : objets / `Buffer`).
- Toute lecture d'une entrée non fiable passe par `src/formats/common/limits.ts` ; vérifie chaque
  offset et longueur avant de lire ; rejette avec une `LockmasterError` au code stable.
- Tout champ réécrit dans `Packages`, XML ou `APKINDEX` est validé (regex du format, pas de
  caractère de contrôle, pas de `\n` injecté) et échappé selon la syntaxe cible.
- Sortie déterministe : tri explicite, pas d'horodatage implicite (le `Date` est un paramètre).
- Seul `src/publish/` écrit dans `data/staging/` et vers les cibles (`publish/targets/*`), selon le
  protocole d'ADR-0003 : construire et vérifier, envoyer les paquets (jamais d'écrasement), envoyer
  la génération, basculer atomiquement, vérifier par HTTP, ramasser. Toute cible implémente la même
  interface `PublishTarget` et passe la même suite de tests de conformité.
- Chaque changement de métadonnées a un test e2e avec le vrai client (`/e2e-client`).
