# ADR-0013 : Même arborescence dans les paquets et dans l'image

- Statut : proposé
- Date : 2026-10-25
- Complète ADR-0007 (§Décision, tableau des livrables et paragraphe sur `/usr/bin/lockmaster`)

## Contexte

ADR-0007 place le bundle des paquets dans `/usr/lib/lockmaster/app/` et fait de `/usr/bin/lockmaster`
un script qui lance `/usr/lib/lockmaster/node/bin/node /usr/lib/lockmaster/app/lockmaster.mjs`, alors
que l'image le place directement sous `/app` (`/app/lockmaster.mjs`). ADR-0009 ajoute un second bundle,
celui du signataire, lancé par `lockmaster signer ...`. Les trois livrables doivent rester
fonctionnellement identiques (`.claude/rules/packaging.md`).

## Décision

Une seule arborescence, sous `/usr/lib/lockmaster` (paquets) et `/app` (image) :
`node/bin/node`, `bin/lockmaster` (lanceur sh), `bin/grype`, `lockmaster.mjs`, `lockmaster-signer.mjs`,
`node_modules/better-sqlite3`, `static/`. Le lanceur (`packaging/bin/lockmaster`) trouve sa racine
par son propre chemin, lance le Node embarqué sur `lockmaster-signer.mjs` pour `lockmaster signer ...`
et sur `lockmaster.mjs` sinon, avec un tas V8 borné. Dans les paquets, `/usr/bin/lockmaster` est un
lien vers `/usr/lib/lockmaster/bin/lockmaster`.

## Justification

Un seul lanceur, testé une fois (`test/integration/launcher.test.ts`), sert les trois livrables ;
aucun chemin propre à un emballage dans le code ou dans le lanceur.

## Alternatives écartées

- Sous-dossier `app/` dans les paquets seulement : deux dispositions à maintenir et deux lanceurs.
- `/app/app/` dans l'image : chemin redondant, et HEALTHCHECK d'ADR-0007 à changer.

## Conséquences

- `packaging/nfpm.yaml` installe `out/stage/root/` dans `/usr/lib/lockmaster` ; le Containerfile
  (M0) copie la même arborescence dans `/app`.
- Le tableau d'ADR-0007 reste valable pour le reste (Node et Grype embarqués, unités, conffile).
