# 09 : Feuille de route (jalons ordonnés)

Règles :
- Un jalon = une branche, livrable seul, avec tests. Ne pas commencer M(n+1) avant que
  **tous** les critères de M(n) soient cochés.
- Chaque jalon se termine par `pnpm check && pnpm test` verts (+ `pnpm test:e2e` à partir de M3),
  une revue `security-reviewer`, et la mise à jour de cette page (cases cochées).
- Si un critère est irréaliste, l'écrire ici avec la raison et ouvrir un ADR ; ne jamais
  le cocher sans le faire.

Distributions supportées (décision du porteur, 2026-10-25) : **Debian 12 et 13**, **Rocky Linux 9
et 10** (et RHEL/AlmaLinux 9 et 10, binairement compatibles), pour l'application, le paquet du
serveur de dépôt et les clients testés en e2e ; Alpine 3.20+ côté clients APK. Les autres
distributions (Ubuntu, Fedora) fonctionnent probablement mais ne sont ni testées ni supportées.

---

## M0 : Squelette, outillage, livraison vide

Exigences `docs/11` : SEC-14 (réseaux compose, clamd par socket), SEC-24 (better-sqlite3 compilé depuis les sources, clés Node commitées, règles CI), SEC-29 (systemd, `redact` des journaux), SEC-19 (CODEOWNERS, CI refuse `.skip`/`.only`).

But : un `lockmaster serve` qui répond, empaqueté dans les trois formats dès le premier jour, et le
serveur de dépôt (paquet `lockmaster-repo` + service nginx `repo`) installable à vide.

- [x] `package.json` (pnpm 12, ADR-0014, `"type": "module"`, `engines.node: ">=24"`, `"license": "MIT"`), `pnpm-workspace.yaml`
      avec `allowBuilds` (better-sqlite3, esbuild) et `minimumReleaseAge`
- [x] `tsconfig.json` strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
      `jsx: react-jsx`, `jsxImportSource: preact`), `biome.json`, `vitest.config.ts`
- [x] `src/config/` : `--config` > `LOCKMASTER_CONFIG` > `/etc/lockmaster/lockmaster.toml` ; smol-toml + schéma zod
      (= `deploy/lockmaster.example.toml`), surcharge `LOCKMASTER__SECTION__CLE`, durées/adresses, clés inconnues
      = erreur, lecture `*_file` avec refus si lisible par others ; `pnpm dev:init` ; tests
- [x] `src/main.ts`, `src/app.ts` (objet `Deps`), `src/http/server.ts` (Fastify, helmet + CSP +
      Permissions-Policy, request-id, erreurs sans fuite, `/healthz`, `/readyz`), CLI minimale
      (`serve`, `init` minimal : clé maîtresse + base vide, `config check`, `healthcheck`)
- [ ] `scripts/check-licenses.mjs` en CI : licences de l'arbre de production conformes à CLAUDE.md
      §Licence ; licences tierces copiées dans les paquets (`/usr/share/doc/<paquet>/`) et l'image
- [x] Hook `onRoute` : toute route doit déclarer `perm` ou `public` ; test
- [x] Robustesse du processus (`docs/01` §4) : arrêt sur exception non gérée, arrêt propre sur
      `SIGTERM`, surveillance de la boucle d'événements, limites HTTP ; tests
- [ ] `.dependency-cruiser.cjs` (règles de couches de `docs/01` §6 : `domain`/`formats` sans
      infrastructure, `http`/`web` sans accès base, application sans `src/signer/`, `web/client` isolé)
      exécuté par `pnpm check` et en CI ; `src/app.ts` construit l'objet `Deps` (injection, aucun
      singleton mutable)
- [ ] Squelette `test/contracts/` (une fonction de suite par interface) et `test/fakes/` ; la CI refuse
      une implémentation d'interface sans appel à sa suite de conformité
- [ ] Tests de garde : grep CI interdisant `child_process.exec(`, `eval(`, `new Function`,
      `dangerouslySetInnerHTML`, `NODE_TLS_REJECT_UNAUTHORIZED` dans `src/`, `x-html`, `hx-on`,
      `style=` et `import 'alpinejs'` dans `src/web/`, ainsi que les caractères typographiques
      interdits par CLAUDE.md §Style d'écriture dans les fichiers du projet (mêmes règles que les hooks)
- [x] Tous les scripts pnpm de `CLAUDE.md` §Commandes existent (même vides pour `test:e2e`/`test:fuzz`)
- [x] `pnpm build` (esbuild -> `dist/lockmaster.mjs`, better-sqlite3 en external copié), `packaging/versions.env`, `packaging/nfpm.yaml` (.deb + .rpm, Node 24
      embarqué et vérifié par SHA-256, unité systemd durcie, utilisateur `lockmaster`, conffile)
- [x] `packaging/Containerfile` multi-étapes, non-root, compatible `docker build` et `podman build` ;
      dossiers `/run/lockmaster-sign`, `/var/lib/lockmaster-signer`, `/var/lib/lockmaster` avec les propriétaires d'ADR-0007
- [ ] Unités `packaging/systemd/` (`lockmaster.service`, `lockmaster-signer.socket`, `lockmaster-signer.service`),
      `packaging/sysusers/lockmaster.conf`, `packaging/tmpfiles/lockmaster.conf` installées par les paquets ;
      `systemd-analyze verify` et `systemd-analyze security` (signataire <= 1,0, application <= 2,0) en CI
- [ ] Quadlets `deploy/quadlet/` (deux comptes) validés par `quadlet -dryrun` en CI ; `deploy/compose.yaml`
      validé par `compose config`
- [x] `packaging/nfpm-repo.yaml` : paquet `lockmaster-repo` (config nginx de référence, `/srv/lockmaster-repo`,
      groupe `lockmaster-repo`, utilisateur `lockmaster-sync` + rrsync, SELinux) ; test `nginx -t` après installation
- [ ] `deploy/nginx/lockmaster-repo.container.conf` régénéré par `packaging/gen-nginx-container-conf.sh`
      (la CI échoue si le fichier commité diffère) ; `deploy/gen-test-cert.sh` (certificat auto-signé
      pour le service `repo` en test et en dev)
- [ ] Sécurité du dépôt GitHub : workflows CodeQL (`javascript-typescript`) et `dependency-review` sur
      les PR, actions épinglées par SHA, `permissions:` minimales ; réglages à activer et documentés
      dans `docs/guide/` : signalement privé de vulnérabilités, analyse des secrets avec protection à
      l'envoi, Dependabot (`.github/dependabot.yml`), branche principale protégée avec revue des
      `CODEOWNERS` (propriétaire : TiotBenjy) ; image publiée sur `ghcr.io/tiotbenjy/lockmaster`
- [ ] `deploy/compose.yaml` (signer + lockmaster + clamav + repo), `deploy/quadlet/` ; CI GitHub Actions : check, test, build, package,
      image, test d'installation du .deb (Debian 12 et 13) et du .rpm (Rocky 9 et 10) qui vérifie `/healthz`

État au 2026-10-25 : les cases restées vides exigent un passage de la CI, ou un réglage du dépôt GitHub
(`docs/guide/securite-github.md`), qui n'a pas encore eu lieu : rien n'a été poussé. Ce qu'elles
décrivent est en place et vérifié en local par les scripts que lance la CI : gardes, contrats,
licences et `pnpm audit` ; `test/deliverables/packages.sh` et `repo-package.sh` sur Debian 12,
Debian 13, Rocky 9 et Rocky 10 (dont `systemd-analyze verify` et `security` : 0,3 pour le
signataire, 1,4 pour l'application) ; `test/deliverables/image.sh` avec Podman rootless et Docker ;
`quadlet -dryrun`, `compose config`, régénération de la configuration nginx. Le critère de sortie
ci-dessous passe de même en local. Limites connues : le contexte SELinux est enregistré
(`semanage`) mais son application aux fichiers ne se vérifie pas dans un conteneur ; les quadlets ne
sont validés que par `quadlet -dryrun` ; l'image n'est publiée sur ghcr.io qu'au premier tag de
version (`release.yml`). À cocher après le premier passage vert de la CI.

Critère de sortie, en CI, pour chacun des trois livrables :
- `.deb` (Debian 12 et 13) et `.rpm` (Rocky 9 et 10) dans un conteneur avec systemd : installation, puis
  `lockmaster init --non-interactive --admin-password-file <f>`, `systemctl start lockmaster`,
  `curl -f localhost:8080/healthz` ; et vérification que `lockmaster serve` **sans** `init` sort avec
  le code 78 et le message « exécuter lockmaster init ».
- Image sous Podman rootless **et** Docker : `lockmaster keys gen-master` via
  `run --rm --entrypoint ...` (ou génération sur l'hôte), puis
  `compose run --rm lockmaster init --non-interactive`, puis `compose up -d` et `/healthz` OK ;
  le service `repo` démarre en lecture seule et répond 404 sur `/` (config nginx chargée).
- Paquet `lockmaster-repo` installé sur Debian 12, Debian 13, Rocky 9 et Rocky 10 : `nginx -t` OK, répertoires et groupes
  créés, contexte SELinux posé sur Rocky.
- Séparation du signataire prouvée sur chaque livrable : sous le compte (ou dans le conteneur) de
  l'application, lire ou lister les fichiers du signataire échoue, un autre compte ne peut pas se
  connecter au socket, et le conteneur `signer` n'a aucune interface réseau.

## M1 : Parseurs et comparaison de versions (purs, sans I/O)

Exigences `docs/11` : SEC-22 (mémoire des décompresseurs : fenêtre zstd, limite xz), SEC-01 (décompression en flux de control/data tar, payload cpio, membres apk, réutilisée par le scan).

- [ ] `formats/common` : lecteur ar, tar en flux (`tar-stream`), gzip/zstd (`node:zlib`),
      xz (bibliothèque choisie et justifiée par ADR), `limits.ts` avec compteur de ratio
- [ ] `formats/deb` : parse `.deb` -> `ParsedPackage` ; parseur/sérialiseur RFC 822 Debian ;
      `compareDebVersion` + vecteurs dpkg
- [ ] `formats/rpm` : lead, signature header, header ; tags nécessaires ; `headerRange` ;
      `rpmvercmp` + vecteurs rpm
- [ ] `formats/apk` : découpe des membres gzip, `.PKGINFO`, vérification `datahash`, `C:` ;
      `compareApkVersion` + vecteurs apk-tools
- [ ] Générateur de fixtures `test/fixtures/build.ts` + corpus malformé ; tests fast-check
      (aucune exception non typée, limites respectées) ; couverture >= 90 %

## M2 : Base, blobs, audit, crypto

Exigences `docs/11` : SEC-21 (points de contrôle d'audit périodiques, clé d'audit dédiée, réglages réservés), SEC-06 (certificat de révocation généré avec chaque clé), SEC-05 (une clé par dépôt).

Reporté de M0 (SEC-29) : la clé maîtresse de l'application est en `root:root` 0400 et transmise par
`LoadCredential=` ; faire de même pour celle du signataire (`lockmaster-signer.service`) quand
`lockmaster init` initialisera le signataire.

- [ ] `db/` : connexion (pragmas), migrations embarquées, `0001_init.sql` (= `docs/05`), helper `tx`
      synchrone, repositories Kysely typés
- [ ] `storage/` : blobs adressés par contenu (tmp + fsync + rename), `paths.ts` validé et testé
- [ ] `crypto/` : `seal/unseal` AES-256-GCM avec AAD, scrypt, jetons, TOTP anti-rejeu, primitives
      OpenPGP (clearsign + détachée) et RSA APK
- [ ] **Service de signature** `src/signer/` (ADR-0009) : protocole (préfixe de longueur, zod, 16 MiB,
      30 s), opérations `ping/status/list-keys/generate-key/rotate-key/retire-key/sign/log` et rien
      d'autre, contrôles par type de demande, identité liée à chaque clé, limites de débit, base
      `signer.db` (clés chiffrées, journal chaîné append-only), écoute par activation systemd ou socket
      créé (vérification 0660 + groupe), CLI `lockmaster signer ...` ; `src/signer-client/` côté application
- [ ] Tests (`test/security/SEC-07*`) : demande non conforme (mauvais `Origin`, contenu arbitraire,
      `Valid-Until` excessif, nom hors motifs) refusée **et journalisée** ; aucune opération n'exporte de
      clé privée ; le code de l'application n'importe jamais `src/signer/` (test de dépendances)
- [ ] `audit/` : `record(tx, ...)` chaîné, triggers append-only, `verify`, export JSONL, checkpoints signés
- [ ] CLI `lockmaster init` (initialise le signataire sous son compte, puis l'application : clés maîtresses,
      bases, une clé par dépôt via le signataire, premier admin **local** membre du groupe local
      `admins-secours` lié au rôle `admin` global, ADR-0010) et `lockmaster audit verify`

## M3 : Publication APT de bout en bout (sans scan)

Exigences `docs/11` : SEC-05 (`Origin`/`Label` uniques, `Valid-Until` 7 j), SEC-25 (hash revérifié pendant l'envoi vers les cibles).

- [ ] `publish/deb` : `Packages`(+gz), `Release`, `InRelease`, `Release.gpg`, by-hash, déterminisme
- [ ] Générations immuables, bascule atomique, conservation K, vérification avant bascule
- [ ] Cible `local` (`publish/targets/local.ts`) : arborescence `public/` d'ADR-0003, fichiers de
      paquets immuables (refus d'écrasement), bascule par lien symbolique, `.lockmaster-target.json`,
      `target_generation`/`target_file`, ramassage, vérification HTTP via `public_url`
- [ ] Marqueurs `private/public-repos/<repo>` publiés dès M3 (dépôts créés publics pour les tests
      M3-M5 ; le défaut « privé » et les htpasswd arrivent en M6)
- [ ] Isolation des cibles : une cible en échec n'empêche ni les autres ni le pipeline ; job rejoué
- [ ] `GET /api/v1/targets`, `POST /api/v1/targets/:name/resync`, `lockmaster targets list|check`,
      `lockmaster publish --target` ; vérification périodique (`publish.verify_interval`) et détection
      de dérive (`.lockmaster-target.json`, liens inattendus)
- [ ] `deploy/nginx/lockmaster-repo.conf` validé (`nginx -t`) et servi par le conteneur `repo`
- [ ] Upload API minimal (jeton créé par CLI) -> état `approved` direct **derrière un drapeau de
      test uniquement** (supprimé en M4)
- [ ] e2e : app + conteneur nginx `repo` (volume partagé) ; clients `debian:12` et `debian:13`
      **interrogent nginx** : `apt update && apt install` du paquet uploadé, avec `Signed-By` ;
      republication pendant un `apt update` en boucle sans erreur ; les dépôts restent servis
      quand l'application est arrêtée

## M4 : Pipeline de sécurité

Exigences `docs/11` : **SEC-01** (ClamAV sur chaque flux interne décompressé ; test : paquet piégé par format et par compression détecté), **SEC-02** (règles d'intégrité de la flotte intégrées et non désactivables), SEC-14 (canari ClamAV périodique), SEC-15 (isolation de Grype), SEC-22 (quotas, files équitables), SEC-25.

Reporté de M0 (revue de l'image) : service `clamav` de compose et des quadlets épinglé mais pas
encore durci (`cap_drop`, `read_only`, `tmpfs`) ; à faire avec le client clamd, en vérifiant le chemin
et les droits du socket. Quadlet `repo` : nginx tourne sous l'UID hôte du compte `lockmaster`
(`keep-id:uid=101`) ; étudier un `UIDMap`/`GIDMap` qui ne projette que le groupe.

- [ ] Machine à états + table de vérité testée ; jobs persistants (`jobs/`) avec reprise
- [ ] Pool de `worker_threads` pour l'analyse des paquets (`resourceLimits`, échéance, recréation) ;
      test : bombe de décompression et paquet qui boucle -> worker terminé, paquet en `error`,
      application toujours disponible
- [ ] Client clamd `zINSTREAM` (tests réels avec EICAR via testcontainers) ; fail-closed
- [ ] SBOM CycloneDX + client grype (`execFile`, timeout, zod sur la sortie) ; base locale
- [ ] Flux KEV et EPSS (téléchargement, validation, swap atomique) ; job `feeds.refresh`
- [ ] Moteur de politique pur + document par défaut + tables de cas ; décisions enregistrées
- [ ] File de revue (API), décisions humaines justifiées, waivers à expiration, 4 yeux (SQL + test)
- [ ] Re-matching quotidien ; notifications « nouvelle CVE bloquante sur paquet publié »
- [ ] Suppression du drapeau de test de M3 ; e2e : EICAR rejeté, paquet vulnérable en revue puis approuvé par un second utilisateur

## M5 : RPM et APK

Exigences `docs/11` : SEC-03 (clés hors bande, `gpgkey=file://`, empreinte affichée ; e2e : un serveur de dépôt qui sert une autre clé ne fait rien installer), SEC-02 (épinglage client : apt preferences, dnf `includepkgs`, apk dépôt étiqueté ; e2e : `openssl` 99.0 interne non installé par `apt upgrade`), SEC-25 (analyse de l'artefact re-signé).

- [ ] `publish/rpm` : primary/filelists/other (+ zst optionnel), repomd, `.asc` ; e2e `dnf install`
      sur Rocky 9 et Rocky 10 avec `gpgcheck=1` et `repo_gpgcheck=1`
- [ ] Signature des RPM (mode `resign`) validée par `rpm -K` ; mode `preserve`
- [ ] `publish/apk` : APKINDEX signé RSA256 ; re-signature des `.apk` ; e2e `apk add` sur Alpine 3.20+
- [ ] Page de configuration client (API) pour les 3 formats

## M6 : Authentification, autorisation, UI

Exigences `docs/11` : SEC-08 (jetons), SEC-09 (OIDC `(iss, sub)`), SEC-10 (MFA), SEC-11 (résolveurs de ressource, listes filtrées), SEC-12 (config htmx, `no-store`), SEC-18 (4 yeux sur les réglages de sécurité).

Reporté de la revue de sécurité de M0 : le hook `onRequest` de `src/http/authorize.ts` refuse
aujourd'hui toute route non publique ; il doit déléguer au contrôle d'accès. `http.request_timeout`
(15 min) s'applique à toutes les routes : avant la première route POST publique (connexion), un
délai court pour les requêtes ordinaires, un délai propre aux uploads dans leur flux, et une limite
de connexions par IP (sinon un client lent occupe les 1024 connexions).

- [ ] Sessions cookie `__Host-`, CSRF, connexion locale, verrouillage, limite par IP, MFA TOTP + codes
      de récupération, réinitialisation de mot de passe (SMTP)
- [ ] RBAC 5 rôles + portée par dépôt, attribués **uniquement par groupes** (ADR-0010) : groupes
      locaux, groupes d'annuaire, `group_role` ; droits effectifs = union ; jetons d'API à portée ;
      test généré routes x rôles x origine du rôle (groupe local / groupe d'annuaire)
- [ ] Interface `DirectoryConnector` + suite de conformité `test/contracts/directory-connector.contract.ts`,
      passée par les deux implémentations et par le faux :
      - OIDC (code + PKCE), groupes lus dans un claim, identité `(iss, sub)`, MFA de l'IdP acceptée
        sur preuve (`amr`/`acr`, `auth_time`) sinon TOTP de l'application (ADR-0010 §5) ;
      - LDAPS Active Directory (`ldapts`) : bind de l'utilisateur, compte de service en lecture seule,
        groupes imbriqués (règle `1.2.840.113556.1.4.1941`), `objectGUID`, CA épinglée, plusieurs
        contrôleurs de domaine, comptes AD désactivés refusés
- [ ] Synchronisation périodique des appartenances, cache daté (`account_directory_group`),
      `max_staleness` (72 h par défaut), alerte si l'annuaire est injoignable
- [ ] Continuité (ADR-0010 §3, e2e avec un conteneur Samba AD) : annuaire coupé -> comptes locaux
      connectés, comptes d'annuaire refusés, jetons valides jusqu'à `max_staleness` puis refusés ;
      retrait d'un groupe dans l'annuaire propagé à la synchronisation suivante ; désactivation locale
      prioritaire ; `disable_local_login` sans effet sur `admins-secours` ; alerte et bandeau à chaque
      connexion de secours
- [ ] UI TSX + htmx + composants Alpine (ADR-0011) : toutes les pages de `docs/07`, selon
      `docs/12-systeme-de-design.md` (jetons, polices Inter et JetBrains Mono de `static/fonts/`,
      icônes Phosphor générées, composants et états) ; `pnpm build` produit `static/app.js` sans
      `eval`/`new Function`
- [ ] Tests UI : contrastes des jetons (`test/web/design-tokens.test.ts`), empreintes des polices
      (`test/web/fonts.test.ts`), tests unitaires de chaque composant Alpine, CSP vérifiée sur chaque
      page ; Playwright à 375, 768 et 1280 px, clair et sombre, `@axe-core/playwright` sans violation
      A/AA, zéro violation CSP, parcours clavier (connexion + MFA, upload, revue 4 yeux, confirmation
      destructive)
- [ ] Dépôts privés par défaut ; identifiants clients par dépôt : génération de
      `private/htpasswd/<repo>.htpasswd` (`$6$`), identifiant de vérification automatique
      (`purpose = 'verify'`) utilisé par la vérification HTTP ; e2e : dépôt privé refusé sans identifiants (401),
      accepté avec ; fichier htpasswd supprimé -> accès refusé (fail closed)

## M7 : Amont, import, miroir

Exigences `docs/11` : SEC-13 (garde SSRF avec résolution épinglée), SEC-17 (monotonicité et identité des index amont), SEC-22 (FTS échappé).

- [ ] Sources amont : téléchargement d'index (APT InRelease, RPM repomd + .asc, APKINDEX signé),
      vérification de signature avec trousseau explicite, cache ETag, garde SSRF
- [ ] Indexation `upstream_package` + FTS ; recherche
- [ ] Résolution de dépendances (alternatives, Provides virtuels, versions, boucles) par format
- [ ] Import (hash vérifié contre l'index) -> pipeline standard ; miroir planifié filtré
- [ ] e2e : import de `nginx` + dépendances depuis un dépôt amont de test (fixture signée servie
      par un conteneur), puis `apt install nginx` depuis Lockmaster

## M8 : Promotion, snapshots, rétention, observabilité, notifications

Exigences `docs/11` : SEC-28 (statistiques syslog), SEC-30 (snapshots re-signés, retrait des paquets devenus dangereux), SEC-18.

- [ ] Canaux, promotion (unitaire et par lot), approbation 4 yeux
- [ ] Snapshots nommés, rollback audité
- [ ] Rétention : versions par canal, blobs orphelins, audit (avec checkpoint), générations
- [ ] Statistiques de téléchargement : écoute syslog UDP (`src/stats/`), sources autorisées, parsing
      du format `lockmaster_json`, agrégation ; `/metrics` (dont `lockmaster_target_*`) ; alertes d'exemple
- [ ] UI : panneau « cibles de publication » de la page Santé (génération active par canal, retard,
      dernière vérification, dérive, bouton « resynchroniser ») ; notification sur dérive ou échec
- [ ] Notifications e-mail + webhooks sortants signés ; SLA de revue
- [ ] Exemples CI `examples/ci/`

## M9 : Exploitation

Exigences `docs/11` : SEC-06 (rotation d'urgence + runbook + exercice e2e), SEC-16 (sauvegardes chiffrées et authentifiées, versionnement de la clé maîtresse), SEC-23 (bundles air-gap signés et épinglés), SEC-27 (migrations de schéma, rotation des clés importées). SEC-26 (S3) est reporté après la v1.

- [ ] `lockmaster backup/restore` (+ `--verify`), sauvegarde pré-migration automatique
- [ ] `lockmaster feeds export/import` et bundles de paquets (air-gap)
- [ ] Cible `rsync` (`publish/targets/rsync.ts`) : `lockmaster targets keygen/trust/check`, rrsync côté
      serveur ; e2e avec un conteneur sshd+rrsync+nginx, **preuve que la bascule des liens est
      atomique** (client en boucle pendant la publication) ; détection de dérive y compris dans
      `private/` (marqueur public ou htpasswd modifié -> alerte + republication)
- [ ] `lockmaster doctor` complet (dont : au moins un compte de secours actif avec MFA dans `admins-secours`,
      état des connecteurs d'annuaire) ; rotation de la clé maîtresse ; rotation des clés de signature
      avec période de transition testée en e2e
- [ ] Documentation utilisateur (`docs/guide/`) : installation .deb/.rpm/conteneur, premiers pas, CI

## M10 : Durcissement et version 1.0

Exigences `docs/11` : revue de **toutes** les exigences SEC-01 à SEC-30 (chacune fermée par son test), décision SEC-07 appliquée, SEC-24 (attestations SLSA, reproductibilité).

- [ ] Fuzzing long sur tous les parseurs (30 min chacun) sans échec
- [ ] Revue `/revue-securite all` sans constat bloquant ; checklist `docs/10-tests.md`
- [ ] Tests de charge : 100 000 paquets dans un dépôt, publication < 60 s, `apt update` < 2 s
- [ ] Livrables signés (cosign pour l'image, signature des .deb/.rpm), SBOM, notes de version
- [ ] Publication des paquets Lockmaster dans une instance Lockmaster (dogfooding)

---

## Couverture fonctionnelle (suivi)

| Fonction | Jalon | Pièges évités (`docs/00`) |
|---|---|---|
| Hébergement DEB/RPM/APK (nginx séparé) | M3, M5, M9 (cibles distantes) | S2 : rien n'est servi hors génération publiée ; G4 : aucune clé sur le serveur de dépôt |
| ClamAV bloquant | M4 | S4 : fail-closed |
| Grype + politique block/review/warn/allow, EPSS, KEV | M4 | S5, S6 : fail-closed, règles `review` par défaut |
| Signature Release / repomd | M3, M5 | G3 : vérifiée avant bascule |
| Signature APKINDEX et paquets RPM/APK | M5 | G1, G2 |
| RBAC 5 rôles | M6 | A2, A3 : rôle relu en base, portée par dépôt |
| Audit + export | M2, M6 | A7 : chaîné, append-only, vérifiable |
| Import amont + dépendances transitives | M7 | G5, G6 : signature et hash obligatoires |
| Miroir planifié | M7 | |
| API pour la CI | M3 (jetons), M6 | A4 : jetons d'API à portée et expiration |
| Statistiques de téléchargement | M8 | journaux nginx JSON reçus en syslog (facultatif) |
| Supervision santé, `/metrics` | M0, M8 | |
| Revue et promotion | M4, M8 | S1, S7, S8 : 4 yeux, plus de `force` |
| Snapshots, rétention | M8 | rétention cohérente avec les métadonnées publiées |
| Notifications e-mail / Slack / Teams | M8 | |
| MFA TOTP | M6 | A6 : anti-rejeu, limite de débit |
| OIDC et LDAPS Active Directory | M6 (OIDC et LDAPS Active Directory natifs, groupes locaux de secours) | A4 ; ADR-0010 : une panne de l'annuaire ne bloque pas l'exploitation |
| Air-gap | M9 | |

## Après la v1

- Cible de publication `s3` (`publish/targets/s3.ts`, SEC-26) : ordre d'écriture, politique de bucket
  refusant `private/`, e2e avec MinIO derrière nginx ; doit passer `publish-target.contract.ts`.
- `KeyStore` PKCS#11 (HSM) pour le signataire, si le besoin est confirmé.
