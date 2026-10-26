# 03 : Formats APT, RPM, APK : lecture, métadonnées, signature

Tout est implémenté en TypeScript dans `src/formats/`. Aucun outil système n'est invoqué.
Les chemins publiés ci-dessous sont relatifs à `public/` sur une cible de publication et servis
par nginx sous le `public_url` de la cible (ADR-0003, ADR-0008) : `https://repo.example.com`
dans les exemples. Les clés publiques sont toutes publiées sous `/keys/`.
Chaque parseur prend un flux ou un `Buffer` **non fiable** et applique les limites de
`src/formats/common/limits.ts` (voir `docs/02-securite.md` §Parsing).

Spécifications de référence (à consulter, ne pas deviner) :

- Debian : <https://wiki.debian.org/DebianRepository/Format>, `deb(5)`, `deb-control(5)`,
  `deb-version(7)`, Debian Policy §5 (champs de contrôle).
- RPM : <https://rpm-software-management.github.io/rpm/manual/format.html> (format v4),
  `rpmvercmp` (`rpmio/rpmvercmp.c`), createrepo_c pour le schéma `repodata`
  (namespaces `http://linux.duke.edu/metadata/common`, `.../rpm`, `.../filelists`, `.../other`, `.../repo`).
- Alpine : `apk-v2(5)` (format v2 : 2 ou 3 flux gzip concaténés), `apk-package(5)`
  pour les champs `.PKGINFO`, `apk-repositories(5)`, `abuild-sign`.
- Lecture utile : implémentations natives de Gitea (`modules/packages/{debian,rpm,alpine}`,
  `services/packages/{debian,rpm,alpine}`, licence MIT) : **comprendre**, ne pas copier sans
  attribution. Forgejo contient le même code mais est sous GPL-3.0+ depuis la v9 : ne pas
  s'en inspirer ligne à ligne.

---

## 1. Concepts communs

Type défini dans `src/domain/package.ts`, produit par chaque implémentation de `PackageFormat`
(`src/formats/package-format.ts` : `parse`, `innerStreams` pour l'antivirus, `compareVersions`) :

```ts
type PackageFormatName = 'deb' | 'rpm' | 'apk';
type VersionOperator = 'lt' | 'le' | 'eq' | 'ge' | 'gt';  // normalisé depuis << <= = >= >>, LT..., < ...
interface Relation { name: string; operator?: VersionOperator; version?: string; qualifier?: string }
type RelationGroup = Relation[];  // alternatives : une seule suffit

interface ParsedPackage {
  format: PackageFormatName;
  name: string;          // validé par regex de format
  version: string;       // version complète telle qu'écrite, validée par la grammaire du format
  arch: string;          // amd64 | arm64 | all | x86_64 | aarch64 | noarch | x86_64(apk) ...
  size: number;
  digests: { sha256: string; sha512: string; sha1: string; md5: string }; // md5/sha1 : compat. métadonnées
  control: Record<string, string>; // champs bruts nécessaires à la régénération des métadonnées
  depends: RelationGroup[];        // Pre-Depends puis Depends en Debian
  provides: Relation[]; conflicts: Relation[]; // conflicts = Conflicts + Breaks en Debian
  replaces: Relation[];  // Replaces (deb), Obsoletes (rpm), replaces (apk) : signal SEC-02
  files?: string[];      // RPM : liste des fichiers (filelists) ; deb/apk : non requis
  sourceName?: string; sourceVersion?: string; // pour le matching CVE (paquet source)
  maintainerScripts: string[]; // noms des scripts présents (preinst, %post, .pre-install...)
}
```

Un **dépôt** (`repository`) a un format, un nom (`debian-bookworm`, `rocky-9`, `alpine-3.20`),
une distribution cible (utilisée pour le SBOM : `debian-12`, `rocky-9`, `alpine-3.20`) et des
**canaux** (ex. `testing`, `stable`). Chaque canal est publié séparément.

Comparaison de versions : trois implémentations pures, testées contre des tables de vecteurs :
`compareDebVersion` (algorithme `deb-version(7)`, `~` < vide < tout), `rpmvercmp` + epoch/release,
`compareApkVersion` (suffixes `_alpha` < `_beta` < `_pre` < `_rc` < (rien) < `_cvs` < `_svn` < `_git` < `_hg` < `_p`, puis `-rN`).
Les vecteurs de test viennent des suites officielles (dpkg `t/`, rpm `tests/rpmvercmp.at`,
apk-tools `test/version.data`) : copier les fichiers de données de test avec leur licence.

---

## 2. Debian / APT

### 2.1 Lecture d'un `.deb`

1. Archive `ar` : magie `!<arch>\n`, entrées 60 octets d'en-tête. Ordre attendu :
   `debian-binary` (contenu `2.0\n`), `control.tar[.gz|.xz|.zst]`, `data.tar[.gz|.xz|.zst|.bz2]`.
   Rejeter toute autre entrée sauf `_gpg*` (signatures debsig, ignorées).
2. `control.tar.*` : décompresser **en flux borné** (<= 10 MiB décompressé), lire `./control`
   (obligatoire), noter la présence de `preinst`, `postinst`, `prerm`, `postrm`, `config`,
   `triggers`. Rejeter liens symboliques/durs et chemins absolus dans `control.tar`.
3. `data.tar.*` : jamais extrait et inutile pour publier, mais décompressé en flux pour l'antivirus
   (SEC-01). Pendant cette même lecture, l'inventaire des entrées est **obligatoire** (pas une
   option) : fichiers setuid/setgid, périphériques, fichiers world-writable, et chemins qui
   s'exécutent en root sans script mainteneur (`/etc/cron*`, `/etc/apt/apt.conf.d/`,
   `/etc/sudoers.d/`, `/etc/ld.so.preload`, `/etc/udev/rules.d/`, `/lib/udev/rules.d/`, unités systemd,
   `/etc/profile.d/`). Ce sont des faits de la règle intégrée `sensitive-content` (SEC-02, `docs/04`).
   Même inventaire pour les fichiers d'un RPM (en-tête : `FILEMODES`, `BASENAMES`) et le membre
   données d'un APK. Réalisation : M4 (décision de la revue de sécurité du parseur deb, 2026-10-26).
4. Parser `control` (format RFC 822 Debian : champs, continuation par espace, ` .` = ligne vide).
   Champs requis : `Package`, `Version`, `Architecture`, `Maintainer`, `Description`.
   Regex `Package` : `^[a-z0-9][a-z0-9+.-]+$`. `Architecture` dans la liste du dépôt ou `all`.
5. Champs réservés refusés dans `control` (quelle que soit la casse) : ceux que l'archive écrit
   elle-même dans `Packages` (`Filename`, `Size`, `MD5sum`, `SHA1`, `SHA256`, `SHA512`,
   `Description-md5`) et ceux de la base de statut de dpkg (`Status`, `Config-Version`, `Conffiles`).
   `Packages` se construit à partir d'une liste de champs autorisés, jamais par recopie du contrôle,
   et toute recherche de champ y est insensible à la casse (M3).

### 2.2 Arborescence publiée (par canal)

```
/apt/<repo>/                               <- URL donnée aux clients (serveur de dépôt)
  dists/<suite>/ -> lien vers _gen/<suite>/<N>/  (bascule atomique, ADR-0003)
  dists/<suite>/InRelease                  (suite = nom du canal, ex. stable ; Codename = codename distro)
  dists/<suite>/Release
  dists/<suite>/Release.gpg
  dists/<suite>/<component>/binary-<arch>/Packages{,.gz,.xz?}
  dists/<suite>/<component>/binary-<arch>/by-hash/SHA256/<hash>
  dists/<suite>/<component>/binary-<arch>/Release  (optionnel)
  pool/<component>/<prefix>/<source>/<name>_<version-sans-epoch>_<arch>.deb   fichier immuable
/keys/lockmaster-archive-keyring.gpg            (clés publiques actives, binaire)
/keys/lockmaster-archive-keyring.asc            (armure)
```

`<prefix>` = première lettre du paquet source, ou `libX` pour les `lib*`. `binary-all` :
les paquets `Architecture: all` sont listés dans **chaque** `binary-<arch>` (comportement attendu
par apt) et `Release` déclare `Architectures: amd64 arm64` sans `all` sauf configuration.

### 2.3 Fichier `Packages`

Une strophe par paquet : tous les champs de `control` dans l'ordre canonique
(`Package, Source, Version, Installed-Size, Maintainer, Architecture, Depends..., Description`),
plus `Filename`, `Size`, `MD5sum`, `SHA1`, `SHA256`, `SHA512`. Strophes séparées par une ligne
vide, triées par (nom, version). Génération déterministe (même entrée -> mêmes octets).

### 2.4 `Release` / `InRelease`

Champs : `Origin`, `Label` (= `repository.origin_label`, uniques par dépôt, `Label` inclut le canal ;
ils servent à l'épinglage client, SEC-02/SEC-05), `Suite`, `Codename`, `Version`?, `Date` (RFC 2822 UTC),
`Valid-Until` (Date + `valid_until_days`, défaut **7 j**, renouvelé par republication planifiée à mi-parcours),
`Architectures`, `Components`, `Description`, `Acquire-By-Hash: yes`,
`Signed-By: <empreinte>` (optionnel), puis `MD5Sum:`, `SHA1:`, `SHA256:`, `SHA512:` listant
chaque fichier d'index avec taille et chemin relatif. `InRelease` = signature OpenPGP **en clair**
(cleartext) de `Release` ; `Release.gpg` = signature détachée armurée. Le moteur de publication
**vérifie** les deux signatures avec la clé publique avant de basculer la génération.

### 2.5 Configuration client (affichée par l'UI)

Principes communs aux trois formats (SEC-02, SEC-03, SEC-05) :
- **La clé publique est installée hors bande** (gestion de configuration, image de base), jamais
  téléchargée depuis le serveur de dépôt sur une machine de production. L'UI affiche l'**empreinte**
  et une commande de vérification ; `/keys/` sur nginx ne sert qu'à l'amorçage manuel, avec avertissement.
- **Une clé par dépôt** : la clé d'un dépôt ne valide que ce dépôt.
- **Épinglage** : un dépôt interne ne peut pas remplacer un paquet de la distribution sur le client,
  même s'il publie une version plus haute.

```
# /etc/apt/sources.list.d/lockmaster-debian-bookworm.sources  (format deb822)
Types: deb
URIs: https://repo.example.com/apt/debian-bookworm
Suites: stable
Components: main
Signed-By: /usr/share/keyrings/lockmaster-debian-bookworm.gpg      # déposé par la gestion de configuration
# Empreinte attendue : affichée par l'UI ; vérifier avec
#   gpg --show-keys --with-fingerprint /usr/share/keyrings/lockmaster-debian-bookworm.gpg

# /etc/apt/preferences.d/lockmaster-debian-bookworm   (épinglage, SEC-02)
Package: *
Pin: release o=<Origin du dépôt>
Pin-Priority: 100

Package: <motifs repository.allowed_names, séparés par des espaces>
Pin: release o=<Origin du dépôt>
Pin-Priority: 500
```

Ne jamais configurer `Check-Valid-Until=no` ni `trusted=yes`.

Avec authentification de dépôt (nginx `auth_basic`, ADR-0008) : `/etc/apt/auth.conf.d/lockmaster.conf`
(`machine repo.example.com/apt/<repo> login ... password ...`, mode 0600). dnf : `username=`/`password=`
dans le `.repo` ; apk : identifiants dans l'URL de `/etc/apk/repositories` (`https://user:secret@...`).

---

## 3. RPM / DNF

### 3.1 Lecture d'un `.rpm`

1. **Lead** 96 octets (magie `ED AB EE DB`, version 3.0). Ignorer le contenu, valider la magie.
2. **Signature header** (magie `8E AD E8 01`, nindex, hsize, index[16 o x n], store), aligné
   sur 8 octets. Tags utiles : `SIZE`(1000), `MD5`(1004), `SHA1HEADER`(269), `SHA256HEADER`(273),
   `RSAHEADER`(268), `PGP`(1002), `DSAHEADER`(267), et le tag de signatures multiples
   introduit par rpm 6 (numéro à vérifier dans `include/rpm/rpmtag.h` avant implémentation).
   **Tout numéro de tag cité ici doit être revérifié contre les sources rpm** : ne pas coder
   de mémoire.
3. **Header** principal : même structure. Tags : `NAME`(1000), `VERSION`(1001), `RELEASE`(1002),
   `EPOCH`(1003), `SUMMARY`, `DESCRIPTION`, `BUILDTIME`, `SIZE`, `LICENSE`, `GROUP`, `URL`,
   `ARCH`(1022), `SOURCERPM`(1044), `PROVIDENAME/FLAGS/VERSION`, `REQUIRENAME/...`,
   `CONFLICTNAME/...`, `OBSOLETENAME/...`, `RECOMMENDNAME...`, `BASENAMES`, `DIRNAMES`, `DIRINDEXES`,
   `FILEMODES`, `FILEFLAGS`, `PAYLOADCOMPRESSOR`, scriptlets `PREIN/POSTIN/PREUN/POSTUN/...`.
   Bornes : nindex <= 65 536, hsize <= 64 MiB, chaque offset/longueur vérifié dans `store`,
   types de tags vérifiés, chaînes terminées par NUL dans les bornes.
4. Le **payload** (cpio compressé) n'est décompressé que pour l'antivirus (SEC-01), jamais extrait.
   `SHA256HEADER` est **obligatoire** et doit correspondre à l'en-tête lu ; `SHA1HEADER`, `SIZE` /
   `LONGSIZE` et `PAYLOADDIGEST` (avec `PAYLOADDIGESTALGO` = 8, SHA-256) sont vérifiés s'ils sont
   présents. Compresseur absent = gzip (comme `rpmte.c`) ; `lzma` refusé (ADR-0015) ; payload autre
   que cpio refusé ; paquet source (lead de type 1) refusé.
5. Calculer `headerStart`/`headerEnd` (octets) : requis par `<rpm:header-range>` dans `primary.xml`
   (`ParsedPackage.headerRange`).
6. Contrôles de structure repris de `lib/header.c` (rpm 4.19.1) : région et trailer couvrant tout
   l'en-tête, entrées croissantes sans chevauchement, types, alignements, nombres, chaînes terminées
   avant le trailer, tags connus au bon type, doublons refusés ; numéros de tags dans
   `src/formats/rpm/tags.ts` avec leur source. Scriptlets signalés (SEC-02) par leur corps ou leur
   seul interpréteur (`%post -p`) : `%pretrans`, `%pre`, `%post`, `%preun`, `%postun`, `%posttrans`,
   `%preuntrans`, `%postuntrans`, `%verifyscript`, déclencheurs (`%triggers`, `%filetriggers`,
   `%transfiletriggers`).

### 3.2 Arborescence publiée

```
/rpm/<repo>/<canal>/<basearch>/
  repodata/repomd.xml
  repodata/repomd.xml.asc               (signature détachée armurée)
  repodata/<sha256>-primary.xml.gz
  repodata/<sha256>-filelists.xml.gz
  repodata/<sha256>-other.xml.gz
  Packages/<n>/<name>-<version>-<release>.<arch>.rpm  fichier immuable
  repodata/ -> lien vers _gen/<N>/ (bascule atomique)
/keys/RPM-GPG-KEY-lockmaster
```

`noarch` est inclus dans chaque `<basearch>`. Option : `primary.xml.zst` (dnf5) en plus de gzip.

### 3.3 Métadonnées

- `primary.xml` : `<package type="rpm">` avec `name`, `arch`, `version epoch= ver= rel=`,
  `checksum type="sha256" pkgid="YES"`, `summary`, `description`, `packager`, `url`,
  `time file= build=`, `size package= installed= archive=`, `location href=`, `format` avec
  `rpm:license`, `rpm:vendor`, `rpm:group`, `rpm:buildhost`, `rpm:sourcerpm`, `rpm:header-range`,
  `rpm:provides/requires/conflicts/obsoletes` (entrées `name flags epoch ver rel pre`), et les
  fichiers « primaires » (`/etc/*`, `*bin/*`, `/usr/lib/sendmail`) comme createrepo.
- `filelists.xml` : tous les fichiers (`<file type="dir|ghost">`).
- `other.xml` : changelogs (limiter aux N derniers, défaut 10).
- `repomd.xml` : `<revision>` (timestamp), une `<data type="primary|filelists|other">` par fichier
  avec `checksum` (compressé), `open-checksum`, `location`, `timestamp`, `size`, `open-size`.
- Échappement XML strict (attributs et texte), suppression des caractères de contrôle invalides
  en XML 1.0 (sinon dnf refuse le fichier).

### 3.4 Signatures

- **Métadonnées** : `repomd.xml.asc` (OpenPGP détachée, armurée). Clients : `repo_gpgcheck=1`.
- **Paquets** : dnf vérifie par défaut la signature de chaque RPM (`gpgcheck=1`). Deux modes,
  par dépôt :
  - `preserve` (défaut pour l'import amont) : conserver la signature d'origine et publier la clé
    amont dans les instructions client ;
  - `resign` (défaut pour l'upload interne) : ajouter/remplacer la signature d'en-tête
    (`RSAHEADER`/`OPENPGP`, signature v4 sur les octets du header) avec la clé du dépôt.
    Le paquet re-signé est un **nouveau blob** (nouveau sha256) ; l'original est conservé et lié.
    Compatibilité : clés **RSA 4096** par défaut (RHEL 9/10 n'acceptent pas toutes les courbes).
    Ce mode est validé en e2e par `rpm -K` et `dnf install` sur Rocky 9 et Rocky 10.

### 3.5 Configuration client

```ini
# /etc/yum.repos.d/lockmaster.repo
[lockmaster-rocky-9-stable]
name=lockmaster rocky-9 stable
baseurl=https://repo.example.com/rpm/rocky-9/stable/$basearch
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-lockmaster-rocky-9     # déposé hors bande (SEC-03) ; importé par rpm --import
includepkgs=<motifs repository.allowed_names>                # épinglage : ce dépôt ne fournit que ses paquets (SEC-02)
# username= / password= si le dépôt exige une authentification
```

Ne jamais mettre une URL `https://` dans `gpgkey=` : dnf importe la clé indiquée là lorsqu'il
rencontre un paquet signé par une clé inconnue (confirmation demandée, sautée avec `-y`), ce qui
permettrait à un serveur de dépôt compromis d'imposer sa clé.

---

## 4. Alpine / APK (format v2)

### 4.1 Lecture d'un `.apk`

Un `.apk` v2 est une concaténation de flux gzip : [signature] + contrôle + données.
1. Découper les membres gzip **sans tout décompresser en mémoire** (décompression en flux,
   détection de fin de membre). Limites : <= 3 membres, contrôle <= 10 MiB décompressé.
2. Membre signature (optionnel) : tar contenant `.SIGN.RSA.<keyname>.rsa.pub` (SHA-1) ou
   `.SIGN.RSA256.<keyname>.rsa.pub` (SHA-256), signature du **membre contrôle compressé**.
3. Membre contrôle : tar (sans bloc de fin) contenant `.PKGINFO` (`clé = valeur`) et scripts
   `.pre-install`, `.post-install`, `.pre-upgrade`, `.post-upgrade`, `.pre-deinstall`,
   `.post-deinstall`, `.trigger`. Champs `.PKGINFO` : `pkgname`, `pkgver`, `arch`, `size`,
   `pkgdesc`, `url`, `license`, `origin`, `maintainer`, `builddate`, `depend`, `provides`,
   `install_if`, `datahash` (sha256 du membre données).
4. Vérifier `datahash` contre le SHA-256 du membre données (lu en flux, non extrait).
5. Le `C:` de l'APKINDEX = `Q1` + base64(SHA-1 du membre contrôle compressé).

### 4.2 Arborescence publiée

```
/apk/<repo>/<canal>/<arch>/APKINDEX.tar.gz       lien vers _gen/<N>/APKINDEX.tar.gz (bascule atomique, après les .apk)
/apk/<repo>/<canal>/<arch>/<pkgname>-<pkgver>.apk   fichier immuable
/keys/<keyname>.rsa.pub
```

### 4.3 `APKINDEX.tar.gz`

- Contenu : `DESCRIPTION` (texte libre) + `APKINDEX` (blocs `C: P: V: A: S: I: T: U: L: o: m: t: c: D: p: i: k:`
  séparés par une ligne vide).
- Construction : flux gzip n°1 = tar **sans bloc de fin** contenant
  `.SIGN.RSA256.<keyname>.rsa.pub` (signature RSA PKCS#1 v1.5 SHA-256 du flux gzip n°2) ;
  flux gzip n°2 = tar contenant `DESCRIPTION` et `APKINDEX`. Concaténer.
  Produire aussi `.SIGN.RSA.` (SHA-1) **seulement** si un client ancien l'exige (option, désactivée).
- Paquets : apk vérifie aussi la signature des paquets avec les clés de `/etc/apk/keys`.
  Modes `preserve` / `resign` comme pour RPM : `resign` remplace le membre signature d'un `.apk`
  par une signature de la clé du dépôt (nouveau blob). Validé en e2e avec `apk add` sur Alpine
  3.20+ (apk-tools 2.x). apk-tools 3 (format v3/ADB) : hors périmètre v1, documenter.

### 4.4 Configuration client

```sh
# Le nom du fichier doit être EXACTEMENT <keyname>.rsa.pub (celui de .SIGN.RSA256.<keyname>.rsa.pub),
# sinon apk répond « UNTRUSTED signature ».
# Clé déposée hors bande (SEC-03) dans /etc/apk/keys/<keyname>.rsa.pub : empreinte affichée par l'UI.
# Dépôt ÉTIQUETÉ (SEC-02) : ses paquets ne sont installés que s'ils sont demandés avec @<repo>.
echo "@<repo> https://repo.example.com/apk/<repo>/stable" >> /etc/apk/repositories
apk update && apk add monpaquet@<repo>
```

---

## 5. Clés de signature

- **Une clé par dépôt par défaut** (SEC-05) : OpenPGP RSA 4096 avec sous-clé de signature,
  expiration 2 ans, pour APT/RPM ; RSA 4096 (PKCS#8) pour APK, nommée `lockmaster-<repo>-<date>`. Le
  cloisonnement empêche de substituer les métadonnées signées d'un dépôt ou d'un canal à un autre et
  limite l'impact d'une compromission. Une clé **distincte** (`purpose = 'audit'`) signe les points de
  contrôle d'audit ; elle n'est jamais publiée aux clients.
- Un **certificat de révocation** OpenPGP est généré avec chaque clé et affiché une seule fois pour
  être conservé hors ligne ; il n'est jamais stocké en base (SEC-06).
- Stockage : **dans le service de signature uniquement** (`lockmaster-signer`, ADR-0009), clé privée chiffrée
  AES-256-GCM avec la clé maîtresse du signataire ; jamais écrite en clair sur disque, jamais
  transmise par le socket. L'application n'en connaît que la partie publique.
- **Rotation** : `lockmaster keys rotate` demande au signataire de créer la nouvelle clé (4 yeux, SEC-18), publie **les deux** clés publiques
  (keyring APT avec 2 clés, `gpgkey=` avec 2 URL, 2 fichiers `.rsa.pub`) pendant la période de
  transition, signe avec la nouvelle, puis retire l'ancienne après confirmation explicite.
- Import d'une clé existante : `lockmaster keys import --openpgp key.asc`. Une clé qui a été stockée sans
  phrase de passe ou montée sur un serveur exposé (piège G4) est considérée comme exposée : on la
  remplace par rotation au lieu de l'importer (SEC-27).
- Rotation d'urgence (paquet malveillant signé, clé compromise) : `lockmaster keys emergency-rotate`
  (SEC-06, runbook M9).
- Extension future : clés dans un HSM (PKCS#11) / KMS, derrière l'interface `KeyStore` **du signataire**.
