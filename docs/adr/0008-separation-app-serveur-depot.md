# ADR-0008 : Séparer l'application du serveur de dépôt (nginx)

- Statut : accepté
- Date : 2026-10-24
- Amende : ADR-0001 (l'app ne sert plus les dépôts), ADR-0003 (publication vers des cibles),
  ADR-0007 (livraison d'un composant serveur de dépôt)

## Contexte

Dans la première version des specs, le processus `lockmaster` servait à la fois l'API, l'interface
d'administration **et** les fichiers des dépôts aux clients `apt`/`dnf`/`apk`. Le porteur du
projet veut séparer les deux rôles :

- l'**application** (gestion : upload, scans, revue, signature, publication, administration) ;
- le **serveur de dépôt** qui héberge et sert les `.deb`/`.rpm`/`.apk` et les métadonnées.

## Décision

1. **Le serveur de dépôt est un nginx standard** qui sert une arborescence **statique** produite
   par l'application. Aucun code Lockmaster ne tourne sur le serveur de dépôt : ni base, ni clé privée,
   ni interface d'admin, ni Node.js. Lockmaster fournit la configuration nginx de référence
   (`deploy/nginx/lockmaster-repo.conf`) et un petit paquet `lockmaster-repo` (.deb/.rpm, sans code) qui
   l'installe avec les répertoires et l'utilisateur de synchronisation.
2. **L'application ne sert plus aucun fichier de dépôt.** Elle reste joignable uniquement par les
   administrateurs, la CI et la CLI ; elle peut vivre sur un réseau interne.
3. **Publication vers une ou plusieurs cibles** (`[[publish.targets]]` dans `lockmaster.toml`) :
   - `local` : un dossier du même hôte (ou un volume partagé en conteneur) que nginx sert en
     lecture seule ;
   - `rsync` : envoi par rsync sur SSH vers un serveur distant (ex. DMZ), clé SSH dédiée, empreinte
     d'hôte épinglée, côté serveur compte restreint par `rrsync` à la seule racine du dépôt ;
   - `s3` (après la v1, ADR-0006) : stockage objet compatible S3, servi par nginx en proxy ou par un CDN.
   Une même publication peut viser plusieurs cibles (miroirs). Le flux réseau va toujours de
   l'application **vers** le serveur de dépôt, jamais l'inverse.
4. **Authentification des clients** (dépôts privés) : nginx `auth_basic` avec des fichiers
   htpasswd générés et publiés par l'application dans une zone non servie de la cible. Par défaut
   un dépôt exige l'authentification ; il n'est public que si l'application publie un marqueur
   explicite (refus par défaut si un fichier manque).
5. **Statistiques de téléchargement** : nginx envoie ses journaux d'accès au format JSON en syslog
   (UDP) vers l'application, qui les agrège (`stats.syslog_listen`, désactivé par défaut, sources
   autorisées configurées). Fonction facultative : sans elle, le dépôt fonctionne.

## Justification

- **Surface d'attaque** : le seul composant exposé aux clients de la flotte est nginx servant des
  fichiers statiques déjà signés. Une compromission du serveur de dépôt ne donne ni les clés de
  signature, ni la base, ni le pouvoir de signer : un fichier modifié sur le serveur est rejeté par
  les clients (signature `InRelease`/`repomd.xml.asc`/`APKINDEX`, et signatures des RPM/APK).
- **Disponibilité** : les dépôts restent servis si l'application est arrêtée (maintenance,
  mise à jour, panne) ; nginx tient très bien la charge et le cache.
- **Topologies** : tout sur un hôte (dossier partagé), ou application interne + un ou plusieurs
  serveurs de dépôt en DMZ / sites distants, sans changer le code.
- **Rien à maintenir** côté serveur de dépôt : nginx et rsync sont dans toutes les distributions.
- Le principe « nginx sert les fichiers » est conservé sans ses pièges : on ne publie que des
  générations complètes et approuvées (pas de `pool/` contenant des paquets en revue : piège S2),
  aucune clé n'est montée côté serveur (piège G4).

## Alternatives écartées

- **Service TypeScript dédié `lockmaster-repo`** : stats et auth plus intégrées, mais un composant de
  code en plus à maintenir et à exposer.
- **Garder le service des fichiers dans l'application** : couple la disponibilité des dépôts à
  celle de l'app et expose l'app à toute la flotte.
- **Autorisation par `auth_request` vers l'application** : recrée une dépendance du serveur de
  dépôt vers l'app pour chaque requête.

## Conséquences

- ADR-0003 est réécrit : la génération est une arborescence statique complète (fichiers de paquets
  compris) poussée vers chaque cible, puis basculée de façon atomique.
- L'application suit l'état de chaque cible (génération active, vérification, erreurs) et l'affiche.
- Retrait d'un paquet pour raison de sécurité : suppression effective du fichier sur toutes les
  cibles, pas seulement de l'index (`docs/04` §5).
- Livraison (ADR-0007) : en plus des paquets/image de l'app, paquet `lockmaster-repo` (config nginx,
  répertoires, utilisateur rsync restreint, contexte SELinux) et service `repo` (image officielle
  nginx non-root) dans `deploy/compose.yaml`.
- Tests e2e : les clients `apt`/`dnf`/`apk` interrogent un conteneur nginx, jamais l'app.
