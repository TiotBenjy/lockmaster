# ADR-0003 : Publication atomique par générations, vers des cibles statiques

- Statut : accepté (révisé le 2026-10-24 par ADR-0008 : publication vers un serveur nginx séparé)
- Date : 2026-10-19

## Contexte

Modifier les dépôts en place (reprepro `includedeb`, `createrepo_c --update`, reconstruction
d'APKINDEX) pendant que nginx sert ces mêmes fichiers est fragile (piège R2), et servir le `pool/`
complet expose les paquets non approuvés (piège S2). Un client qui télécharge
`Release` puis `Packages` pendant une mise à jour peut obtenir un mélange incohérent
(« Hash Sum mismatch »). Depuis ADR-0008, les fichiers sont servis par un nginx séparé qui ne lit
que ce que l'application lui publie.

## Décision

### Arborescence sur une cible

```
<racine de la cible>/                       ex. /srv/lockmaster-repo
  public/                                   <- racine web de nginx (lecture seule pour nginx)
    keys/                                   clés publiques actives (APT .gpg/.asc, RPM-GPG-KEY-lockmaster, <keyname>.rsa.pub)
    apt/<repo>/
      pool/<component>/<p>/<source>/<fichier>.deb   fichiers immuables, jamais réécrits
      _gen/<suite>/000043/                  InRelease, Release, Release.gpg, <comp>/binary-<arch>/Packages{,.gz}, by-hash/
      dists/<suite> -> ../_gen/<suite>/000043       lien symbolique (suite = canal)
    rpm/<repo>/<channel>/<arch>/
      Packages/<initiale>/<fichier>.rpm
      _gen/000043/                          repomd.xml, repomd.xml.asc, <sha256>-primary.xml.gz, ...
      repodata -> _gen/000043
    apk/<repo>/<channel>/<arch>/
      <pkgname>-<pkgver>.apk
      _gen/000043/APKINDEX.tar.gz
      APKINDEX.tar.gz -> _gen/000043/APKINDEX.tar.gz   lien symbolique (même mécanisme que RPM)
    snapshots/<repo>/<channel>/<nom>/       générations épinglées (détail par format ci-dessous)
  private/                                  <- jamais servi par nginx
    htpasswd/<repo>.htpasswd                identifiants clients (dépôts privés)
    public-repos/<repo>                     marqueur : dépôt public (absent = authentification exigée)
  .lockmaster-target.json                        identité de la cible + dernière génération (détection de dérive)
```

- Une **génération** est l'état complet d'un canal : métadonnées signées dans `_gen/<N>/` et
  ensemble des fichiers de paquets qu'elles référencent.
- **Fichiers de paquets immuables** : un chemin de paquet n'est jamais réécrit. Si le chemin existe
  déjà sur la cible avec un autre sha256, la publication échoue et lève une alerte (dérive ou
  falsification de la cible).
- **Seuls des paquets `approved` présents dans une génération** existent sur la cible : un paquet
  en revue, rejeté ou en erreur n'a jamais d'URL.
- APT : `Acquire-By-Hash: yes` ; chaque nouvelle génération recopie dans son `by-hash/` les index
  des K−1 générations précédentes, ce qui élimine les « Hash Sum mismatch ». Un même `pool/` par
  dépôt pour toutes les suites (canaux), comme une archive Debian.
- RPM : `repodata` est un lien vers la génération ; les fichiers de métadonnées sont nommés par hash.
- APK : `APKINDEX.tar.gz` est un lien vers `_gen/<N>/APKINDEX.tar.gz` ; les `.apk` sont envoyés avant.
  Les trois formats basculent donc de la même façon (lien symbolique), ce qui rend rollback et
  snapshots uniformes.
- Fichiers partagés entre canaux (RPM/APK) : lien physique **à l'intérieur de la cible** (jamais vers
  les blobs de `/var/lib/lockmaster`, qui doivent rester illisibles par nginx), sinon copie.

### Protocole de publication (par canal, pour chaque cible)

1. **Construire** la génération N+1 dans `data/staging/` depuis la base : métadonnées, signatures,
   puis **vérifier** (relecture, signatures contrôlées avec la clé publique, chaque paquet référencé
   est `approved`).
2. **Envoyer les fichiers de paquets manquants** (vérification de non-écrasement).
3. **Envoyer** `_gen/N+1/`.
4. **Basculer** de façon atomique : remplacement du lien symbolique (`dists/<suite>`, `repodata`,
   `APKINDEX.tar.gz`) par création d'un lien temporaire puis `rename`.
5. **Vérifier par HTTP** (si `verify = true`) : télécharger `InRelease`/`repomd.xml`/`APKINDEX.tar.gz`
   depuis `public_url` de la cible et comparer au sha256 attendu. Pour un dépôt privé, l'application
   utilise son identifiant de vérification (`repo_credential.purpose = 'verify'`, créé automatiquement,
   publié dans le htpasswd comme les autres). Les `public_url` sont exemptés de la garde SSRF.
6. **Ramasser** : supprimer les générations au-delà des K conservées (défaut 5) et les fichiers de
   paquets qui ne sont plus référencés par aucune génération conservée ni par un snapshot.

Chaque cible a son propre état (`target_generation`, `docs/05`). Une cible en échec n'empêche pas
les autres d'avancer ; l'échec est visible dans l'UI, `/readyz` et `/metrics`, et le job est rejoué.

### Cibles

| Type | Écriture | Bascule atomique | Remarques |
|---|---|---|---|
| `local` | `fs` : écriture dans un fichier temporaire, `fsync`, `rename` | lien temporaire + `rename` | même hôte ou volume partagé avec nginx |
| `rsync` | `rsync` sur SSH (`execFile`, arguments fixes, clé dédiée, `StrictHostKeyChecking=yes` avec `known_hosts` épinglé) ; côté serveur `command="rrsync /srv/lockmaster-repo",restrict` | rsync remplace les fichiers et liens via nom temporaire + `rename` (à **prouver par un test e2e** en M9 ; sinon, commande de bascule dédiée autorisée par la clé) | passes successives : paquets, `_gen`, liens, puis suppressions |
| `s3` (après la v1) | API S3, objets écrits dans l'ordre : paquets -> index nommés par hash -> fichiers racine en dernier | pas de liens : by-hash (APT) et noms par hash (RPM) assurent la cohérence ; fenêtre résiduelle documentée entre `repomd.xml` et `repomd.xml.asc` | nginx en proxy du bucket ou CDN |

### Déclenchement

Job persistant `publish` (table `job`) avec `dedupe_key = publish:<repo>:<channel>` : au plus un
job en file par canal, un seul worker de publication par canal, toutes cibles traitées dans ce job.
Événements déclencheurs : paquet promu, supprimé, retiré ; clé changée ; renouvellement de
`Valid-Until` ; changement d'identifiants clients (régénère `private/`) ; ajout d'une cible
(publication complète).

### Snapshots et rollback

- Un **snapshot nommé** épingle une génération : ses métadonnées et fichiers ne sont pas ramassés.
  Exposition (URL de base à donner au client) :
  - APT : `snapshots/<repo>/<nom>/` contenant `dists/<suite> -> .../apt/<repo>/_gen/<suite>/<N>` et
    `pool -> .../apt/<repo>/pool` ;
  - RPM : `snapshots/<repo>/<channel>/<nom>/<arch>/` contenant `repodata -> .../_gen/<N>` et
    `Packages -> .../rpm/<repo>/<channel>/<arch>/Packages` (les `href` de `primary.xml` sont relatifs) ;
  - APK : `snapshots/<repo>/<channel>/<nom>/<arch>/` contenant `APKINDEX.tar.gz -> .../_gen/<N>/APKINDEX.tar.gz`
    et un lien par `.apk` référencé.
  Tous les liens sont relatifs et restent sous `public/` (contrôlé par test et par `lockmaster targets check`).
- Un **rollback** repointe le lien vers une génération conservée, sur toutes les cibles (audité).
- **Retrait de sécurité** (malware découvert après coup, CVE avec option `retire`) : nouvelle
  génération sans le paquet, **suppression immédiate du fichier** sur toutes les cibles, et les
  générations/snapshots qui le référençaient sont marqués `purged` (plus de rollback vers elles).

## Conséquences

- La base est la seule vérité ; `lockmaster publish --all [--target T]` reconstruit et repousse tout,
  y compris vers une nouvelle cible vide.
- Plus de reprepro/createrepo_c/apk-tools ; plus aucun service de fichiers dans l'application.
- Seul `src/publish/` écrit vers les cibles et dans `data/staging/`.
