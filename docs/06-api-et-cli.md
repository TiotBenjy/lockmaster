# 06 : API REST, publication vers le serveur de dépôt, CLI

## 1. Principes

- Préfixe `/api/v1`. JSON uniquement (sauf upload binaire et exports). Schémas zod ->
  validation + types + OpenAPI (`/api/v1/openapi.json`, réservé aux utilisateurs authentifiés).
- Authentification API : `Authorization: Bearer lkm_<...>` (jeton d'API). Les cookies de session
  sont **ignorés** sur `/api/v1` (pas de CSRF possible). L'UI n'appelle pas l'API JSON : elle a
  ses propres routes de formulaires/fragments sous `/` (même logique métier, autre transport).
- Chaque route déclare `config: { perm: 'pkg:upload', repoParam: 'repo' }` ; un hook global
  `onRoute` refuse le démarrage si une route n'a ni `perm` ni `public: true`.
- Pagination par curseur : `?limit=50&cursor=<opaque>` -> `{ items, nextCursor }`, `limit` <= 200.
- Erreurs : `{ "error": { "code": "PKG_DUPLICATE", "message": "...", "requestId": "..." } }`.
  Codes HTTP : 400 validation, 401 non authentifié, 403 interdit, 404, 409 conflit,
  413 trop gros, 422 paquet invalide, 429 limite, 503 dépendance indisponible.
- Idempotence : uploads idempotents par sha256 ; `Idempotency-Key` accepté sur les POST de décision/promotion.
- Limites de débit : par jeton et par IP (`@fastify/rate-limit`), plus strictes sur `/login`.

## 2. Endpoints (permission requise ; `R` = portée dépôt)

Règles transverses (détail : `docs/02` §3.5) :
- **Toute route `GET` d'administration** (utilisateurs, sources, réglages, file de revue,
  promotions, waivers, jobs, clés) accepte sa permission d'écriture **ou** `system:read`
  (rôle auditor, lecture seule globale).
- Portée dépôt de `import:run` = dépôt cible de la source ; de `waiver:manage` = `waiver.repo_id`
  (waiver global : rôle global requis).

### Paquets
| Méthode | Chemin | Perm |
|---|---|---|
| PUT/POST | `/repos/:repo/packages` (corps brut ou multipart) -> 202 | `pkg:upload` R |
| GET | `/repos/:repo/packages?name=&state=&channel=&arch=` | `repo:read` R |
| GET | `/packages/:id` (`?wait=120` long-poll jusqu'à état terminal) | `repo:read` R |
| GET | `/packages/:id/events` (SSE progression pipeline) | `repo:read` R |
| GET | `/packages/:id/findings` | `repo:read` R |
| GET | `/packages/:id/sbom` (CycloneDX) | `repo:read` R |
| GET | `/packages/:id/download` | `repo:read` R |
| DELETE | `/packages/:id` (retire de tous les canaux, état `deleted`, blob purgé par la rétention) | `pkg:delete` R |
| POST | `/packages/:id/rescan` | `pkg:upload` R |

### Revue, décisions, waivers, politique
| Méthode | Chemin | Perm |
|---|---|---|
| GET | `/review?repo=&sort=` | `review:decide` R ou `system:read` |
| POST | `/packages/:id/decisions` `{verdict, reason, waiver?}` | `review:decide` R (4 yeux) |
| GET/POST | `/waivers` ; DELETE `/waivers/:id` (révocation) | `waiver:manage` |
| GET | `/policy` ; PUT `/policy` (validée, versionnée) | `repo:read` / `policy:manage` |
| POST | `/policy/simulate` `{document}` -> impact sur le catalogue actuel | `policy:manage` |
| GET | `/vulns?kev=&severity=` ; GET `/vulns/:id` (paquets affectés) | `repo:read` |

### Canaux, promotions, publication
| Méthode | Chemin | Perm |
|---|---|---|
| POST | `/packages/:id/promote` `{to}` -> 200 ou 202 (demande) | `pkg:promote` R |
| GET | `/promotions?state=pending` | `pkg:promote` R |
| POST | `/promotions/:id/approve` / `/reject` `{reason}` | `pkg:promote` R (4 yeux) |
| GET | `/repos/:repo/channels/:ch/generations` | `repo:read` R |
| POST | `/repos/:repo/channels/:ch/publish` (forcer) | `repo:manage` R |
| POST | `/repos/:repo/channels/:ch/rollback` `{generation, reason}` | `repo:manage` R |
| GET/POST | `/repos/:repo/channels/:ch/snapshots` ; DELETE `.../snapshots/:name` | `repo:read` / `repo:manage` R |

### Dépôts, sources amont, import
| Méthode | Chemin | Perm |
|---|---|---|
| GET/POST | `/repos` ; GET/PATCH/DELETE `/repos/:repo` (DELETE refusé si non vide) | `repo:read` / `repo:manage` |
| GET/POST/DELETE | `/repos/:repo/credentials` (identifiants clients apt/dnf/apk, secret affiché une fois) | `repo:manage` R |
| GET | `/repos/:repo/client-setup?client=apt|dnf|apk|dockerfile` | `repo:read` R |
| GET/POST/PATCH/DELETE | `/sources`, `/sources/:id` | `source:manage` |
| POST | `/sources/:id/refresh` (job) | `import:run` |
| GET | `/sources/:id/search?q=` | `import:run` |
| POST | `/sources/:id/resolve` `{packages:[...]}` -> plan (manquants, déjà présents, introuvables) | `import:run` |
| POST | `/sources/:id/import` `{packages, withDependencies}` -> job | `import:run` |

### Identités, accès, audit, système
| Méthode | Chemin | Perm |
|---|---|---|
| GET/POST/PATCH | `/users`, `/users/:id` (pas de DELETE : désactivation) | `user:manage` |
| GET/POST/PATCH/DELETE | `/groups` (groupes locaux), `/groups/:id/members` | `user:manage` (4 yeux si le groupe porte admin/maintainer) |
| GET/POST/DELETE | `/directory-groups` (groupes d'annuaire connus : recherche dans l'AD, ajout pour mapping) | `user:manage` |
| GET/POST/DELETE | `/group-roles` (liaison groupe local ou d'annuaire -> rôle global ou par dépôt) | `user:manage` (4 yeux pour admin/maintainer) |
| GET | `/directory/status` (connecteurs : joignable, dernière synchronisation, contrôleur actif) ; POST `/directory/sync` | `system:read` / `user:manage` |
| GET/POST/DELETE | `/tokens` (les siens), `/users/:id/tokens` (admin) | authentifié / `user:manage` |
| GET | `/audit?actor=&action=&target=&from=&to=` ; `/audit/export?format=jsonl|csv` | `audit:read` |
| POST | `/audit/verify` | `audit:read` |
| GET | `/keys` (publiques) ; POST `/keys/rotate` ; POST `/keys/:id/retire` | `repo:read` / `key:manage` |
| GET/PATCH | `/settings` (rétention, planifs, notifications ; secrets masqués) | `settings:manage` |
| GET | `/jobs`, `/jobs/:id`, `/jobs/:id/events` (SSE) ; POST `/jobs/:id/cancel` | `system:read` / créateur |
| GET | `/system/status` (versions, âge des bases, santé scanners, disque) | `system:read` |
| GET | `/stats/downloads?repo=&from=&to=` | `repo:read` |
| GET | `/targets` (cibles de publication : génération active par canal, dernière vérification HTTP, erreurs) | `system:read` |
| POST | `/targets/:name/resync` (republication complète vers une cible, ex. nouveau miroir) | `repo:manage` (global) |

### Hors `/api/v1`
| Chemin | Accès |
|---|---|
| `/healthz` | public (`ok`) |
| `/readyz` | public : `ready`/`not ready` seulement ; détail via `/api/v1/system/status` |
| `/metrics` | jeton ou écoute locale (config) |

## 3. Ce que l'application publie pour le serveur de dépôt

L'application **ne sert aucun fichier de dépôt** (ADR-0008). Les URL `/apt/...`, `/rpm/...`, `/apk/...`,
`/snapshots/...` et `/keys/...` sont servies par nginx sur l'hôte du dépôt (`public_url` de chaque
cible), à partir de l'arborescence décrite dans ADR-0003. L'application y écrit :

- `public/` : générations signées, fichiers de paquets approuvés, clés publiques actives ;
- `private/htpasswd/<repo>.htpasswd` : un fichier par dépôt privé, régénéré à chaque changement de
  `repo_credential` ; mots de passe au format `crypt()` SHA-512 (`$6$`, accepté par nginx sur glibc,
  libxcrypt et musl) ; les secrets sont aléatoires (32 o) et affichés une seule fois à la création ;
- `private/public-repos/<repo>` : marqueur vide présent **seulement** si le dépôt est déclaré public
  (`repository.require_auth = 0`). Absence = authentification exigée (refus par défaut) ;
- `.lockmaster-target.json` : identifiant de la cible, numéro de génération par canal, date, utilisé pour
  détecter une dérive (cible modifiée ou restaurée hors de l'application).

Les en-têtes HTTP (types MIME explicites, `Cache-Control` : `no-cache` pour
`InRelease`/`Release`/`Packages`/`repomd.xml`/`APKINDEX.tar.gz`, `immutable` pour `by-hash/`,
paquets et `repodata/<hash>-*`), la lecture seule et l'authentification sont dans
`deploy/nginx/lockmaster-repo.conf`. `GET /api/v1/repos/:repo/client-setup` construit les instructions
à partir du `public_url` de la cible principale (la première déclarée).

## 4. CLI `lockmaster`

Option globale : `--config <fichier>` (sinon `LOCKMASTER_CONFIG`, sinon `/etc/lockmaster/lockmaster.toml`).

```
lockmaster serve                         démarre le service (défaut de l'unité systemd et de l'image)
                                    ; sans clé maîtresse ou base initialisée, refuse de démarrer
                                    avec un message clair « exécuter lockmaster init » (code de sortie 78)
lockmaster init [--non-interactive]      (root) initialise le signataire sous son compte, puis l'application :
                                    clés maîtresses, bases, une clé de signature par dépôt, admin + MFA
lockmaster doctor                        diagnostic : config, permissions, clamd, grype, bases, clés, horloge, disque,
                                    séparation du signataire (socket 0660 lockmaster-sign, fichiers illisibles par lockmaster)
lockmaster healthcheck                   sonde pour le HEALTHCHECK conteneur (code retour)
lockmaster config check|show             valide / affiche la config effective sans secrets
lockmaster user add|passwd|disable|mfa-reset|list
lockmaster token create --user --scope --expires
lockmaster repo create|list ; lockmaster source add|list
lockmaster keys gen-master [--out F] | list | rotate | retire | export-public
                                    (rotate/retire : demandes au signataire via le socket, 4 yeux SEC-18)
lockmaster keys rotate-master --new F    rechiffre les secrets de l'application avec une nouvelle clé maîtresse

Service de signature (exécuté sous le compte lockmaster-signer ; ADR-0009) :
lockmaster signer init                   base du signataire, clé maîtresse du signataire si absente
lockmaster signer serve [--socket P | --socket-activation]
lockmaster signer keys list | import --openpgp|--apk --repo R | export-revocation K | emergency-rotate --repo R
lockmaster signer log [--since ...]        journal de signatures (vérification de la chaîne incluse)
lockmaster signer rotate-master --new F
lockmaster publish --all | --repo R [--channel C] [--target T]
lockmaster targets list | check [T]       état des cibles ; check = vérification HTTP et détection de dérive
lockmaster targets keygen T | trust T     clé SSH dédiée à une cible rsync ; épinglage confirmé de la clé d'hôte
lockmaster audit verify | export
lockmaster backup --to F [--verify] ; lockmaster restore --from F
lockmaster feeds update | export --out F | import F --trusted-key K
lockmaster export --channel ... --out F ; lockmaster import-bundle F
```

La CLI s'exécute sous l'utilisateur `lockmaster` (refuse root sauf `init`/`doctor`, et `init` corrige
les propriétaires). Les commandes qui écrivent passent par les mêmes services que l'API et
écrivent l'audit avec l'acteur `cli:<utilisateur système>`.

## 5. Exemple CI (GitHub Actions / GitLab)

```bash
curl --fail-with-body -sS -T "dist/app_1.2.3_amd64.deb" \
  -H "Authorization: Bearer $LOCKMASTER_TOKEN" \
  -H "X-Lockmaster-Expected-SHA256: $(sha256sum dist/app_1.2.3_amd64.deb | cut -d' ' -f1)" \
  "https://lockmaster.example.com/api/v1/repos/debian-bookworm/packages" | tee resp.json
id=$(jq -r .id resp.json)
curl --fail-with-body -sS -H "Authorization: Bearer $LOCKMASTER_TOKEN" \
  "https://lockmaster.example.com/api/v1/packages/$id?wait=300" | jq -e '.state == "approved"'
```

Exemples complets dans `examples/ci/` (GitHub Actions, GitLab CI, Jenkins) : jalon M8.
