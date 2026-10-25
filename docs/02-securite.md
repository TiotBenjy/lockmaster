# 02 : Sécurité : modèle de menace, invariants, contrôles

Objectif : scan ClamAV bloquant, scan CVE avec politique, signature, RBAC et audit, sans aucun des
pièges recensés dans `docs/00-perimetre-et-pieges.md`.

## 1. Actifs à protéger

| Actif | Pourquoi c'est critique |
|---|---|
| Clés privées de signature (OpenPGP, RSA APK) | Qui les détient peut faire installer n'importe quoi en root sur toute la flotte |
| Intégrité des dépôts publiés | Idem : un paquet malveillant publié = compromission de la flotte |
| Décisions de sécurité et journal d'audit | Preuve de conformité ; doivent être inaltérables |
| Comptes admin / jetons CI | Permettent de publier ou de lever un blocage |
| Clé maîtresse | Déchiffre clés de signature et secrets |
| Disponibilité du service de dépôt | Les déploiements de la flotte en dépendent |

## 2. Attaquants et scénarios (STRIDE résumé)

| # | Scénario | Contrôles |
|---|---|---|
| A1 | Uploader authentifié (ou jeton CI volé) envoie un paquet piégé, ou usurpe un paquet de la distribution (`openssl 99.0`, `Obsoletes`, epoch...) pour exécuter du code root sur toute la flotte | Règles intégrées non désactivables (`docs/04` §3, SEC-02) : propriété des noms par dépôt, noms protégés, revue 4 yeux pour scripts mainteneur / nouveau nom / epoch / remplacement de paquets ; épinglage côté client ; ClamAV sur les flux **décompressés** (SEC-01) ; audit |
| A2 | Paquet forgé pour exploiter le parseur (zip bomb, en-têtes RPM incohérents, tar path traversal, XML/RFC822 injection dans les métadonnées) | Parsing borné en flux, aucun fichier extrait, validation stricte des champs (regex, longueurs, caractères de contrôle), sérialisation des métadonnées avec échappement, tests de propriétés |
| A3 | Miroir amont compromis ou MITM | Index amont accepté seulement si signature valide avec trousseau explicite ; hash de chaque paquet vérifié contre l'index signé ; TLS vérifié ; puis pipeline de scan complet comme un upload |
| A4 | Vol de session / CSRF / XSS sur l'UI admin | Cookie `__Host-`, `HttpOnly`, `SameSite=Strict` ; CSRF synchronisé ; TSX auto-échappé ; CSP sans `unsafe-*` ; pas de jeton en `localStorage` |
| A5 | Brute-force / credential stuffing | scrypt ; verrouillage par compte ; limite par IP ; MFA TOTP obligatoire pour admin/maintainer ; OIDC recommandé |
| A6 | Jeton CI volé | Jetons à portée minimale (`pkg:upload:<repo>`), expiration obligatoire (<= 1 an), stockés hachés, révocables, `last_used_at` visible, alerte sur usage depuis une nouvelle IP (option) |
| A7 | Escalade de privilèges entre dépôts | RBAC par dépôt ; chaque route déclare sa permission ; test d'énumération des routes ; tests d'autorisation négatifs systématiques |
| A8 | Initié qui approuve son propre paquet bloqué | Principe des 4 yeux imposé en base (trigger sur `decision`, CHECK sur `promotion_request`) pour les levées de blocage, décisions de revue et promotions vers un canal à approbation |
| A9 | Altération du journal d'audit ou de la base | Chaîne de hachage + triggers append-only + points de contrôle signés + export ; `lockmaster audit verify` |
| A10 | Lecture des données au repos (sauvegarde volée) | Clés et secrets chiffrés AES-256-GCM avec clé maîtresse **hors** du répertoire de données et hors des sauvegardes |
| A11 | SSRF via URL de source amont ou de webhook sortant (les `public_url` des cibles, déclarés par l'administrateur dans `lockmaster.toml`, sont explicitement exemptés de la liste d'IP interdites, car souvent en RFC1918) | URL validées (https par défaut, http autorisé seulement explicitement pour l'amont), résolution DNS vérifiée contre une liste d'IP interdites (loopback, link-local, métadonnées cloud 169.254.169.254, RFC1918 sauf autorisation explicite), pas de redirection vers un autre hôte, timeouts, taille max de réponse |
| A12 | Déni de service (uploads énormes, index amont géant, requêtes coûteuses) | Limites de taille, quotas par utilisateur/jeton, files de jobs bornées, pagination obligatoire, `connectionTimeout`/`requestTimeout`, `bodyLimit` |
| A13 | Compromission de la chaîne d'approvisionnement de Lockmaster lui-même | pnpm lockfile, scripts d'installation bloqués, `minimumReleaseAge`, peu de dépendances, binaires (Node, Grype) vérifiés par SHA-256, SBOM et signature des livrables, `pnpm audit` en CI |
| A14 | Exécution de commande via un champ de paquet passé à un processus | Aucune donnée de paquet dans des arguments de processus ; Grype reçoit un fichier SBOM écrit par Lockmaster (nom aléatoire dans `data/tmp`) |
| A15 | Compromission du serveur de dépôt (nginx exposé à la flotte) | Aucune clé privée, aucune base, aucun code Lockmaster sur cet hôte (ADR-0008) : l'attaquant ne peut pas produire de métadonnées ou de paquets acceptés par les clients **à condition que les clés publiques soient installées hors bande** (SEC-03 : jamais `gpgkey=https://...` ni téléchargement depuis `/keys/` en production). Il peut couper le service ou servir une ancienne génération (attaque par gel/rétrogradation) : limitée par `Valid-Until` (APT), détectée par la vérification HTTP périodique de l'application (hash attendu) et la détection de dérive (`.lockmaster-target.json`), contournable par un serveur qui présente les bons fichiers à l'application seulement : la supervision de fraîcheur côté flotte (SEC-05) est la vraie détection |
| A16 | Vol de la clé SSH de publication (cible `rsync`) | Clé dédiée par cible, forcée côté serveur par `command="rrsync /srv/lockmaster-repo",restrict` (pas de shell, pas de redirection, une seule racine) ; empreinte d'hôte épinglée. Sans clé de signature, l'attaquant ne peut pas publier de paquet accepté par les clients. **Mais** il peut écrire dans `private/` : poser un marqueur `public-repos/<repo>` ou remplacer un htpasswd, donc **exposer un dépôt privé**, et couper le service. Contre-mesures : `.lockmaster-target.json` contient le sha256 de chaque fichier de `private/` ; la vérification périodique (`publish.verify_interval`) relit `private/` par rsync (lecture) et compare ; tout écart -> alerte, republication de `private/` et notification ; rotation immédiate de la clé (`lockmaster targets keygen`) |
| A17 | Accès aux dépôts privés | Authentification exigée par défaut côté nginx (marqueur explicite pour un dépôt public, refus si fichier manquant) ; htpasswd hors racine web ; secrets aléatoires 32 o ; TLS obligatoire sur le serveur de dépôt |
| A18 | Usurpation de journaux de statistiques (syslog UDP) | Écoute désactivée par défaut, liée à une interface interne, sources autorisées par IP ; ne contient aucune donnée de décision : au pire, statistiques faussées |

## 3. Invariants (rappel de CLAUDE.md, avec détails)

### 3.1 Pipeline fail-closed
Machine à états unique `src/pipeline/state.ts` ; transitions explicites et testées.
`approved` n'est atteignable que via `policy(allow|warn)` ou `human(allow)` après **tous**
les scans en `pass`. Un scanner indisponible/timeout -> `error` + job de reprise ; un paquet en
`error` n'est jamais publié. Le publieur ne lit que `channel_entry` dont le paquet est `approved`
(double vérification dans la requête de génération).

### 3.2 Parsing borné (`src/formats/common/limits.ts`)

| Limite | Défaut |
|---|---|
| Taille d'un paquet | `http.max_upload_bytes` (2 GiB) |
| Taille décompressée d'un membre de contrôle | 10 MiB |
| Ratio de décompression | <= 100:1 sur les membres décompressés |
| Entrées tar dans le contrôle | <= 1 000 |
| Champ texte de contrôle | <= 64 KiB, total <= 1 MiB |
| En-tête RPM | nindex <= 65 536, store <= 64 MiB |
| Fichiers listés (RPM) | <= 500 000 |
| Temps de parsing | 30 s (AbortSignal) |

Caractères refusés dans tout champ republié : octet nul, `\r`, caractères de contrôle C0/C1
(sauf `\n` + règles de continuation RFC 822 pour la description Debian), séquences UTF-8 invalides.
Les noms/versions/arch suivent des regex strictes par format avant tout usage.

### 3.3 Cryptographie

| Usage | Choix |
|---|---|
| Hash de mot de passe | scrypt N=2^17, r=8, p=1 (~128 MiB : passer `maxmem: 256 * 1024 * 1024` à `crypto.scrypt`, la valeur par défaut de 32 MiB lève une erreur), sel 16 o, 64 o de sortie, format `scrypt$N$r$p$sel$hash`, appel asynchrone ; limite de 4 calculs simultanés (file) contre l'épuisement mémoire ; re-hachage transparent si les paramètres changent |
| Jetons (session, API, reset, identifiants de dépôt) | 32 o `crypto.randomBytes`, base64url ; stockés en SHA-256 ; comparaison `timingSafeEqual` |
| Chiffrement au repos | AES-256-GCM, nonce 12 o aléatoire, AAD contextuelle, clé maîtresse 32 o |
| Signature APT/RPM | OpenPGP RSA 4096 (défaut), Ed25519 en option pour APT seul |
| Signature APK | RSA 4096, PKCS#1 v1.5 SHA-256 |
| TOTP | RFC 6238, SHA-1, 6 chiffres, pas 30 s, fenêtre ±1, **anti-rejeu** (`totp_last_step`) ; secret 20 o chiffré ; 10 codes de récupération hachés |
| Audit | SHA-256 chaîné + points de contrôle signés OpenPGP |
| Webhooks sortants | HMAC-SHA256 `X-Lockmaster-Signature: t=<ts>,v1=<hex>` (anti-rejeu par horodatage) |

**Deux clés maîtresses** (ADR-0009) : celle de l'application (secrets tiers, TOTP, identifiants)
et celle du signataire (clés de signature), chacune lisible par un seul compte. La clé maîtresse de l'application vient d'un fichier (`security.master_key_file` : `root:lockmaster` mode 0440 pour les
paquets ; secret de conteneur lisible par l'UID 10001) ; Lockmaster refuse de démarrer si elle manque,
est trop courte, est lisible par `others`, ou se trouve sous `data_dir`.
Rotation : `lockmaster keys rotate-master --new <fichier>` rechiffre tout en une transaction.

### 3.4 Authentification et sessions
- Première installation : `lockmaster init` (CLI) crée l'admin **en local sur la machine** ; il n'existe
  **pas** d'assistant web de premier lancement exposé au réseau (piège A5 : fenêtre d'attaque entre
  l'installation et la création de l'admin). Variante conteneur : `lockmaster init` lancé
  via `docker exec`/`podman exec`, ou mot de passe initial lu depuis un secret fichier.
- Session : identifiant 32 o, rotation à la connexion et à l'élévation MFA, expiration
  d'inactivité (30 min) et absolue (12 h), révocation de toutes les sessions au changement de
  mot de passe/rôle, liste des sessions actives visible par l'utilisateur.
- Messages d'erreur de connexion identiques pour « utilisateur inconnu » et « mauvais mot de passe »,
  temps de réponse égalisé (hash factice).
- Réinitialisation de mot de passe : jeton 1 h, usage unique, stocké haché, toutes sessions révoquées.
- OIDC : flux code + PKCE + `state` + `nonce`, vérification `iss`/`aud`/`exp`, découverte via HTTPS.

### 3.5 Autorisation

Permissions atomiques (`src/auth/permissions.ts`) :
`repo:read`, `pkg:upload`, `pkg:delete`, `pkg:promote`, `review:decide`, `waiver:manage`,
`policy:manage`, `repo:manage`, `source:manage`, `import:run`, `key:manage`, `user:manage`,
`audit:read`, `settings:manage`, `system:read`.

| Rôle | Permissions (globales ou limitées au dépôt lié) |
|---|---|
| reader | `repo:read` |
| uploader | reader + `pkg:upload` |
| maintainer | uploader + `pkg:delete`, `pkg:promote`, `import:run`, `review:decide`*, `waiver:manage`* |
| auditor | `repo:read`, `audit:read`, `system:read`, globalement uniquement |
| admin | tout |

\* soumis au principe des 4 yeux.

- `system:read` = **lecture seule de tout l'état d'administration** : utilisateurs (sans secrets),
  sources amont, réglages (secrets masqués), politique, file de revue, promotions, jobs, santé.
  Toute route GET d'administration accepte sa permission d'écriture **ou** `system:read`.
- **Portée dépôt** : `pkg:*`, `review:decide`, `repo:read`, `repo:manage` portent sur le dépôt de
  la ressource ; `import:run` sur `upstream_source.target_repo_id` ; `waiver:manage` sur
  `waiver.repo_id` (un waiver global, `repo_id` NULL, exige le rôle global correspondant).
  Résolution unique dans `src/auth/scope.ts`, testée.
- **Les rôles s'attribuent uniquement à des groupes** (ADR-0010) : groupes **locaux** (gérés dans
  l'application) et groupes **d'annuaire** (Active Directory en LDAPS, ou claims OIDC). Droits
  effectifs = union des rôles des groupes du compte. Un rôle limité à un dépôt ne peut pas dépasser
  `maintainer` ; `auditor` et `admin` sont uniquement globaux.
- **MFA selon le connecteur** (ADR-0010 §5) : TOTP de l'application pour les comptes locaux et
  LDAPS ; MFA de l'IdP pour les comptes OIDC si `amr`/`acr` et `auth_time` le prouvent, sinon repli
  sur le TOTP de l'application. Jamais d'élévation `admin`/`maintainer` sans second facteur.
- **Continuité si l'AD tombe** : les comptes locaux (dont le groupe de secours `admins-secours`, MFA
  obligatoire, connexion toujours alertée) se connectent normalement ; les comptes d'annuaire ne
  peuvent pas se connecter (aucun mot de passe AD n'est vérifié ni stocké localement) ; leurs jetons
  d'API restent valides avec les appartenances en cache tant que la dernière synchronisation date de
  moins de `auth.directory.max_staleness` (72 h). La désactivation locale prime toujours.
- Les permissions d'un jeton d'API sont l'**intersection** de ses portées et des droits de son
  propriétaire **au moment de l'usage** (rôles relus en base à chaque requête).
- **4 yeux**, imposés en base (`docs/05`) : une décision humaine `allow` sur un paquet ne peut pas
  être prise par son uploader (`decision.actor != package_version.uploaded_by`), et une promotion
  vers un canal à approbation ne peut pas être approuvée par son demandeur. Exception explicite :
  une instance mono-utilisateur peut activer `review.allow_self_approval` (réglage audité,
  désactivé par défaut, bannière permanente dans l'UI).

### 3.6 HTTP
- `@fastify/helmet` : CSP (ADR-0004), `Strict-Transport-Security` (si TLS), `X-Content-Type-Options`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-origin`. helmet n'émet pas `Permissions-Policy` : l'ajouter
  dans un hook `onSend` (`camera=(), microphone=(), geolocation=(), payment=(), usb=()`).
- CORS désactivé. `trustProxy` seulement pour `http.trusted_proxies`.
- L'application ne sert aucun fichier de dépôt ; `/api/v1/packages/:id/download` (administration)
  répond avec `Content-Type: application/octet-stream`, `Content-Disposition: attachment`, `nosniff`.
- Erreurs : `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`, jamais de pile.
- `/metrics` protégé (jeton ou écoute locale), `/healthz` minimal sans détail interne,
  `/readyz` détaillé seulement pour `system:read`.
- OpenAPI/Swagger exposé seulement aux utilisateurs authentifiés.

### 3.7 Exécution
- Utilisateur dédié non-root, `umask 027`, fichiers de données 0640/0750.
- systemd durci et conteneur `read_only`, `cap_drop: ALL` (ADR-0007).
- Sous-processus autorisés : `grype`, `rsync` et `ssh` (lancé par rsync), tous par chemin absolu
  configuré, environnement reconstruit, `stdout` limité à 64 MiB, `stderr` limité et journalisé tronqué.
- Aucune fonctionnalité ne requiert le socket Docker, sudo, ou un accès à la flotte. Le seul usage
  de SSH est la publication sortante vers une cible `rsync` (deuxième sous-processus autorisé :
  `rsync`, chemin absolu, arguments fixes, `-e "/usr/bin/ssh -F /dev/null -i <clé> -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<fichier épinglé> -o BatchMode=yes"`, aucun nom
  fourni par un utilisateur ; chemins de `rsync`/`ssh` configurables, vérifiés par `lockmaster doctor`).

### 3.7 bis Service de signature (`lockmaster-signer`, ADR-0009)
- Compte Linux distinct, aucun réseau (`PrivateNetwork=yes` / `Network=none`), socket Unix 0660
  groupe `lockmaster-sign` (seul le compte de l'application en est membre), base et clé maîtresse
  lisibles par lui seul. Vérifié : un autre compte ne peut pas se connecter au socket ; le compte de
  l'application ne peut ni lire ni lister les fichiers du signataire, ni remplacer son socket.
- Contrôles avant signature par type de demande (identité liée à la clé, dates, structure), limite de
  débit par clé, journal de signatures chaîné propre au signataire et exporté par l'hôte.
- Ce qui reste possible à un attaquant maître de l'application : obtenir des signatures **conformes**
  (métadonnées de son dépôt, noms autorisés) tant qu'il est présent : chacune journalisée hors de sa
  portée. Ce qui ne l'est plus : copier une clé et signer ailleurs, plus tard, sans trace.
- Exposition systemd mesurée (`systemd-analyze security --offline`) : `lockmaster-signer.service` 0,3 (SAFE),
  `lockmaster.service` 1,4 (OK).

### 3.8 Serveur de dépôt (nginx)
- Configuration de référence `deploy/nginx/lockmaster-repo.conf` : lecture seule (GET/HEAD), pas
  d'`autoindex`, `server_tokens off`, types MIME explicites, `nosniff`, HSTS, fichiers cachés
  refusés, `disable_symlinks if_not_owner from=$document_root`, tout chemin hors `/keys`, `/apt`,
  `/rpm`, `/apk`, `/snapshots` -> 404.
- Authentification par dépôt refusée par défaut (voir A17). Testé sur nginx 1.24 : dépôt privé
  sans identifiants ou avec mauvais mot de passe -> 401, fichier htpasswd absent -> 403, `$6$` accepté.
- Liens symboliques : `disable_symlinks if_not_owner` refuse un lien vers un fichier d'un autre
  propriétaire (ex. root), mais **pas** vers un fichier du compte publieur hors de la racine.
  Barrières : (1) nginx n'a de droits de lecture que via le groupe `lockmaster-repo`, `/var/lib/lockmaster`,
  `/etc/lockmaster` et le home de `lockmaster-sync` ne doivent jamais être lisibles par ce groupe ni par
  « others » (vérifié par `lockmaster doctor` et le `postinstall` de `lockmaster-repo`) ; (2) l'application ne
  crée que des liens **relatifs** dont la cible résolue reste sous la racine de la cible (test) ;
  (3) `lockmaster targets check` parcourt la cible et signale tout lien ou fichier inattendu (dérive).
- Système de fichiers : `public/` et `private/` appartiennent à l'utilisateur qui publie
  (`lockmaster` en cible locale, `lockmaster-sync` en rsync), groupe `lockmaster-repo` dont nginx est membre,
  fichiers 0640 / répertoires 0750 ; nginx n'a aucun droit d'écriture. Conteneur `repo` : volume
  monté en lecture seule, image nginx non-root, `read_only`, `cap_drop: ALL`.
- RHEL/Fedora : contexte SELinux `httpd_sys_content_t` sur `/srv/lockmaster-repo` (posé par le paquet
  `lockmaster-repo`), aucun booléen SELinux à relâcher.
- Le serveur de dépôt n'a besoin d'aucun flux sortant (sauf syslog facultatif vers l'application).

## 4. Journalisation et détection

Événements de sécurité journalisés (audit + log) : connexions réussies/échouées, verrouillages,
MFA activée/désactivée, création/révocation de jetons, changements de rôle, décisions humaines,
waivers, changements de politique, rotation de clés, publication/rollback, échec de vérification
de signature amont, détection malware. Notifications configurables sur : malware détecté,
paquet bloqué, KEV nouvellement associé à un paquet publié, échec de job planifié, clé proche
de l'expiration, base CVE obsolète (> 48 h), ClamAV obsolète (> 48 h).

## 5. Analyse globale

L'analyse de sécurité globale (`docs/11-analyse-securite.md`) complète ce document : ses exigences
SEC-01 à SEC-30 sont normatives.

## 6. Revue de sécurité continue

- Agent `security-reviewer` (`.claude/agents/security-reviewer.md`) sur chaque changement sensible.
- CI : `pnpm audit --prod`, Biome (règles de sécurité), test « toutes les routes ont une
  permission », test « pas de `child_process.exec` / `eval` / `dangerouslySetInnerHTML` »,
  tests de propriétés des parseurs, scan de l'image (Grype sur l'image Lockmaster elle-même), SBOM.
- Avant chaque version : `/revue-securite all` + checklist `docs/10-tests.md` §Sécurité.
