# 10 : Stratégie de test

**La preuve de compatibilité, ce sont les vrais clients** : chaque format est validé par `apt`,
`dnf` et `apk` contre les dépôts publiés par nginx, pas seulement par nos propres parseurs.

## Méthode : TDD obligatoire

Tout comportement nouveau ou corrigé suit **rouge -> vert -> refactor** (CLAUDE.md §TDD) :
1. écrire le test qui exprime le comportement (ou reproduit le bug), le lancer, le voir échouer pour
   la bonne raison ;
2. écrire le code minimal qui le fait passer ;
3. refactorer, tests au vert.

Conséquences pratiques :
- Le test et le code sont commités ensemble, ou le test d'abord ; `git-guard.mjs` refuse un commit
  `feat`/`fix`/`sec`/`perf` qui modifie `src/` sans test.
- On teste le comportement observable (entrées, sorties, effets, erreurs typées), pas les détails
  internes : un refactoring ne casse aucun test.
- **Suites de conformité** (`test/contracts/<interface>.contract.ts`) : chaque implémentation d'une
  interface de `docs/01` §6, et chaque faux de `test/fakes/`, appelle la suite de son interface. Les
  tests d'intégration utilisent les faux ; leur fidélité est garantie par cette même suite.
- Horloge et aléa injectés (`Deps.clock`, `Deps.random`) : aucun test ne dépend de l'heure réelle ni
  d'un délai (`sleep`).

## Pyramide

| Niveau | Outil | Portée | Quand |
|---|---|---|---|
| Unitaires | vitest | `domain/`, `formats/`, `crypto/`, politique, versions | `pnpm test` (< 30 s) |
| Propriétés / fuzz | fast-check | parseurs deb/rpm/apk/control/XML, comparateurs de versions | `pnpm test` (court), `pnpm test:fuzz` (long, nocturne) |
| Intégration | vitest + `fastify.inject` + SQLite temporaire | routes HTTP, authz, pipeline avec scanners factices, publication | `pnpm test` |
| Scanners réels | conteneur `clamav/clamav` (CLI Podman ou Docker, ADR-0016) + binaire grype | client clamd (EICAR), parsing de sortie grype | `pnpm test:e2e` |
| Bout en bout | conteneurs (CLI Podman ou Docker, ADR-0016) : Lockmaster + conteneur nginx `repo` (config `deploy/nginx/lockmaster-repo.conf`, volume partagé en lecture seule) + clients `debian:12`, `debian:13`, `rockylinux:9`, `rockylinux/rockylinux:10`, `alpine:3.20` + dernière Alpine stable | upload -> scan -> publication -> `apt install` / `dnf install` / `apk add` **via nginx** (les clients ne joignent jamais l'app) ; dépôt privé (401 sans identifiants) ; rotation de clé ; rollback ; import amont ; cible rsync (sshd + rrsync) | `pnpm test:e2e`, CI |
| Livrables | CI | installation du `.deb` (Debian 12/13) et du `.rpm` (Rocky 9/10) dans des conteneurs systemd ; image sous Docker et Podman rootless (scripts `test/deliverables/`, aussi lancés en local) | CI à chaque push et PR |

Les conteneurs sont pilotés par `test/e2e/support/containers.ts` (ADR-0016) : `podman`, sinon
`docker`, ou le moteur nommé par `LOCKMASTER_E2E_ENGINE` ; images épinglées par digest dans
`packaging/versions.env`. Formats (M1) : `test/e2e/formats/versions.test.ts` confronte les trois
comparateurs de versions à dpkg, rpm et apk (vecteurs amont, paires aléatoires, validité) ;
`test/e2e/formats/packages.test.ts` passe à nos parseurs de vrais paquets (officiels et construits par
`dpkg-deb` et `rpmbuild` avec chaque compression) et compare le résultat à `dpkg-deb`, `rpm`,
`rpm2cpio`, `createrepo_c` et `apk index`.

## Fixtures

- **Jamais de paquets binaires tiers commités.** Les paquets de test sont **générés** en mémoire par
  les générateurs de `test/fixtures/builders/` (un par format : ar, tar, cpio, xz, bzip2, deb, rpm,
  apk ; chacun accepte des altérations pour produire un cas malformé), ou construits dans un
  conteneur (`dpkg-deb`, `rpmbuild`) par les tests e2e (`test/e2e/formats/packages.test.ts`).
- Paquets réels amont téléchargés **dans des conteneurs jetables uniquement** (jamais commités),
  vérifiés par le gestionnaire de paquets de la distribution, pour valider le parseur sur du contenu
  réel (bash, tzdata, busybox...) : `test/e2e/formats/packages.test.ts`.
- Fichier EICAR généré à la volée (jamais commité tel quel : il déclenche les antivirus des postes).
- Cas malformés générés dans les tests de chaque format par les générateurs ci-dessus : ar tronqué,
  tar avec `../`, lien symbolique, bombe gzip, en-tête RPM avec offsets hors bornes, `.PKGINFO`
  géant, champs avec octet nul, caractères de contrôle. Corpus sur disque produit par de vrais
  outils (`xz`, `bzip2`, GNU tar) avec son manifeste : `test/fixtures/corpus/`, régénéré par
  `test/fixtures/corpus-generate.ts`.

## Tests de sécurité obligatoires (`test/security/`, protégés : SEC-19)

Chaque exigence SEC de `docs/11` est fermée par un test nommé `SEC-xx ...`. Exemples incontournables :
- **SEC-01** : pour `.deb` (gzip, xz, zstd, bzip2 ; motif dans `data` **et** dans `postinst`), `.rpm`
  (gzip, xz, zstd) et `.apk`, un paquet piégé avec une signature de test chargée dans le clamd de test
  est rejeté ; un paquet dont la compression est inconnue part en `error`.
- **SEC-02** : `openssl` 99.0, epoch augmenté, `Obsoletes`/`Replaces` d'un nom protégé, premier upload
  d'un nom, script mainteneur, setuid -> tous en `pending_review` ; nom hors `allowed_names` -> `rejected`.
- **SEC-03** : un serveur de dépôt qui sert une clé et des métadonnées d'un attaquant ne fait rien
  installer sur des clients configurés selon la page « configuration client ».
- **SEC-05** : métadonnées signées d'un autre dépôt ou canal servies à la place -> refusées par le client.
- **SEC-11** : matrice générée routes x rôles x dépôt lié/non lié, y compris routes par identifiant,
  listes agrégées et flux SSE.
- **SEC-07 / ADR-0009** : demandes de signature non conformes refusées et journalisées ; séparation
  prouvée pour chaque mode (paquets, quadlets deux comptes, compose) : l'application ne lit pas les
  fichiers du signataire, un compte tiers ne joint pas le socket, le signataire n'a pas de réseau.

La CI vérifie que le nombre de tests de `test/security/` ne diminue pas et refuse `.skip`, `.only`,
`.todo` dans ce dossier.

## Tests obligatoires par domaine

**Formats** : pour chaque format : aller-retour (parse -> métadonnées -> parse des métadonnées),
déterminisme (deux générations identiques à l'octet), vecteurs officiels de comparaison de
versions, chaque fichier malformé rejeté avec un code d'erreur précis et sans dépasser les limites
mémoire/temps.

**Signature** : signature vérifiée par OpenPGP.js **et** par les vrais clients (`gpgv` dans le
conteneur Debian, `rpm -K` et `dnf` dans Rocky, `apk` dans Alpine) ; rotation : un client
configuré avec l'ancienne clé continue de fonctionner pendant la période de transition.

**Pipeline** : table de vérité de la machine à états ; chaque scanner en échec/timeout -> pas de
publication ; décision humaine sans justification refusée ; auto-approbation refusée (4 yeux).

**Politique** : tables de cas (sévérité x CVSS x EPSS x KEV x fix disponible x waiver actif/expiré).

**Authz** : test généré : pour chaque route x chaque rôle x dépôt lié/non lié, code HTTP attendu ;
test « toute route déclare une permission ». Tests CSRF (absence/mauvais jeton -> 403) et
« l'API refuse les cookies ».

**Audit** : chaque mutation produit exactement une entrée ; `lockmaster audit verify` détecte une
modification, une suppression et une insertion en milieu de chaîne ; UPDATE/DELETE bloqués.

**Amont** : index avec signature invalide refusé ; paquet dont le hash diffère de l'index refusé ;
redirection vers un autre hôte refusée ; IP interdite (SSRF) refusée ; résolution de dépendances
sur des index figés (fixtures) avec alternatives, `Provides` virtuels, boucles.

**HTTP (application)** : en-têtes de sécurité présents sur toutes les réponses ; erreurs sans pile ;
aucune route ne sert de fichier de dépôt.

**Publication et serveur de dépôt** : un paquet non `approved` n'apparaît jamais sur une cible ;
écrasement d'un fichier existant refusé ; bascule atomique (client en boucle pendant la publication,
zéro erreur) ; ramassage (fichiers non référencés supprimés, snapshots préservés) ; retrait de
sécurité supprime le fichier sur toutes les cibles ; dérive détectée si `.lockmaster-target.json` ou un
fichier est modifié hors de l'app ; nginx : `nginx -t` (sur la plus ancienne version cible : nginx 1.20/1.22), méthodes autres que GET/HEAD -> 405,
lien vers un fichier root hors racine -> 403, `Content-Type` attendus, aucun en-tête de cache sur les erreurs,
fichiers cachés et `private/` -> 404, dépôt privé sans htpasswd -> refus, types MIME attendus.

## Interface web (ADR-0004, ADR-0011, `docs/12`)

| Niveau | Outil | Ce qui est vérifié |
|---|---|---|
| Composants Alpine | vitest (+ `happy-dom` si `$el`/`$refs`) | état initial, méthodes, transitions d'état, cas limites ; une fabrique = un fichier de test écrit avant elle |
| Rendu serveur | vitest + `app.inject` | structure accessible (un `h1`, libellés, `aria-*`, états), droits (ce qu'on ne peut pas faire n'est pas affiché), en-têtes (CSP, `no-store`), absence de `style=`, `on*=`, `x-html`, `hx-on` |
| Jetons et polices | vitest | contrastes AA des paires de `docs/12` §2 dans les deux thèmes ; aucune couleur littérale hors jetons ; sha256 des polices = `static/fonts/SHA256SUMS` |
| Parcours | Playwright (`test/e2e/ui/`) | connexion + MFA, upload, revue 4 yeux, confirmation destructive, au clavier seul ; 375, 768 et 1280 px ; clair et sombre ; `prefers-reduced-motion` |
| Accessibilité | `@axe-core/playwright` sur chaque page | zéro violation de niveau A et AA |
| CSP | Playwright | écoute de `securitypolicyviolation` : zéro violation sur chaque page et chaque interaction |

## Couverture

Seuils CI (vitest + v8) : `formats/`, `crypto/`, `auth/`, `pipeline/` >= 90 % lignes et branches ;
global >= 80 %. La couverture n'est pas un objectif en soi : un test sans assertion utile est refusé
en revue.

## Checklist sécurité avant version

- [ ] `pnpm audit --prod` sans vulnérabilité haute/critique non justifiée
- [ ] Grype sur l'image Lockmaster : aucune critique corrigeable
- [ ] `pnpm test:fuzz` 30 min sans échec
- [ ] e2e verts sur toutes les distributions cibles
- [ ] `/revue-securite all` sans constat bloquant
- [ ] SBOM et signatures (cosign, paquets) produits et vérifiés
