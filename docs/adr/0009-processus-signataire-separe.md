# ADR-0009 : Processus signataire séparé (`lockmaster-signer`)

- Statut : accepté (décision du porteur, 2026-10-24), résout SEC-07 de `docs/11`
- Amende : ADR-0001 (deux processus : l'application et le signataire), ADR-0007 (livraison)

## Contexte

Les clés de signature (une par dépôt, SEC-05) permettent de faire installer du code en root sur
toute la flotte. Dans la conception initiale, elles étaient déchiffrées dans le processus Node qui
reçoit les paquets du réseau et analyse leur contenu non fiable. Une faille dans cette analyse
(exécution de code) aurait permis de **copier** les clés et de signer ensuite n'importe quoi, hors
de toute surveillance.

## Décision

Un second programme, **`lockmaster-signer`**, détient seul les clés privées et effectue toutes les
signatures. Il est livré dans le même artefact que l'application (`lockmaster signer serve`) mais tourne :

- sous un **compte Linux distinct** (`lockmaster-signer`), qui seul peut lire ses fichiers et sa clé maîtresse ;
- **sans réseau** (`PrivateNetwork=yes` / `Network=none`) ;
- en n'exposant qu'un **socket Unix** (`/run/lockmaster-sign/sign.sock`, mode 0660, groupe `lockmaster-sign`
  dont seul le compte de l'application est membre).

L'application ne possède plus aucune clé privée : elle envoie au signataire ce qu'il faut signer.

### Ce que le signataire vérifie avant de signer

Il ne lit **pas** la base de l'application (partager ce volume entre comptes casserait la séparation,
et l'application écrit cette base de toute façon). Il vérifie ce qu'on lui demande de signer :

| Type de demande | Clé utilisée | Contrôles |
|---|---|---|
| `apt-release` (renvoie `InRelease` + `Release.gpg`) | OpenPGP du dépôt | analyse RFC 822 stricte ; `Origin`/`Label` = identité liée à la clé ; `Date` ~maintenant (±5 min) ; `Valid-Until` <= Date + 30 j ; uniquement des lignes de sommes de contrôle bien formées |
| `rpm-repomd` (renvoie `repomd.xml.asc`) | OpenPGP du dépôt | XML bien formé, élément racine `repomd`, `revision` ~maintenant, uniquement des entrées `data` |
| `rpm-header` (signature d'en-tête de paquet, mode `resign`) | OpenPGP du dépôt | en-tête RPM analysé avec les mêmes limites que `docs/03` ; `NAME` conforme aux motifs de noms liés à la clé |
| `apk-index` (renvoie la signature RSA de l'APKINDEX) | RSA APK du dépôt | flux gzip contenant un tar avec exactement `DESCRIPTION` et `APKINDEX` |
| `apk-package` (mode `resign`) | RSA APK du dépôt | membre de contrôle `.PKGINFO` analysé ; `pkgname` conforme aux motifs liés à la clé |
| `audit-checkpoint` | clé d'audit | structure `{seq, hash, at}` uniquement |

- **Identité liée à chaque clé** : nom du dépôt, format, `origin_label`, motifs de noms autorisés.
  Elle est fixée à la création ou à la rotation de la clé, côté signataire, et ne peut être modifiée
  que par sa CLI locale (pas par le socket).
- **Limites de débit** par clé (ex. 120 signatures/minute, configurable) ; dépassement -> refus,
  alerte.
- **Journal de signatures** propre au signataire : chaque signature (horodatage, clé, type, sha256
  du contenu signé, identité de la demande) est ajoutée à un journal chaîné par hachage dans sa base,
  écrit dans journald et, si configuré, exporté hors hôte (syslog). L'application ne peut ni le
  modifier ni l'effacer. Elle peut le lire (`log` sur le socket) pour l'afficher et le rapprocher de
  ses générations : une signature sans génération correspondante déclenche une alerte.

### Opérations du socket (et rien d'autre)

`ping`, `status`, `list-keys` (parties publiques), `generate-key` (pour un dépôt, avec son identité),
`rotate-key`, `retire-key`, `sign`, `log`. **Jamais** d'export de clé privée ni de modification de
l'identité d'une clé par le socket. L'import d'une clé existante, l'export du certificat de
révocation et la rotation d'urgence passent par la CLI locale du signataire
(`lockmaster signer ...`, exécutée sous le compte `lockmaster-signer`).

Protocole : messages JSON délimités par leur longueur (préfixe 4 octets), 16 MiB maximum, validés
par zod des deux côtés, une requête par connexion, délai maximal 30 s.

### Déploiements

| Mode | Séparation obtenue | Mise en œuvre |
|---|---|---|
| **.deb / .rpm (systemd)** | par compte Linux | `lockmaster.service` (`User=lockmaster`), `lockmaster-signer.service` (`User=lockmaster-signer`, `PrivateNetwork=yes`), `lockmaster-signer.socket` (activation par socket, `SocketUser=lockmaster-signer`, `SocketGroup=lockmaster-sign`, `SocketMode=0660`) |
| **Podman rootless, deux comptes (quadlets)** : recommandé en conteneur | par compte Linux + conteneur | comptes `lockmaster` et `lockmaster-signer`, chacun avec son Podman rootless ; dossier hôte `/run/lockmaster-sign` (tmpfiles, `2750 lockmaster-signer:lockmaster-sign`) monté dans les deux ; `UserNS=keep-id` ; côté application `--group-add keep-groups` (runtime crun) ; même `SecurityLabelLevel` SELinux |
| **compose (Docker ou Podman, un seul compte)** | par conteneur | service `signer` sans réseau, seul à monter le volume des clés et la clé maîtresse du signataire ; volume `sign-sock` partagé. Protège contre une faille dans l'application, **pas** contre une évasion de conteneur : réservé aux environnements où les deux comptes ne sont pas possibles |

Fichiers de référence : `packaging/systemd/`, `deploy/quadlet/`, `deploy/compose.yaml` (décrit dans
`docs/08`).

## Justification

- La clé ne peut plus être **copiée** depuis l'application : une compromission de l'application
  permet au pire de demander des signatures conformes aux contrôles ci-dessus, pendant la durée de
  l'intrusion, et chacune est journalisée hors de portée de l'attaquant.
- Le signataire est minuscule (objectif < 1 500 lignes hors bibliothèques de format partagées), sans
  réseau ni HTTP, ce qui réduit fortement sa surface d'attaque.
- Même artefact, même image : pas de chaîne de livraison supplémentaire.

## Alternatives écartées

- **Signature dans l'application avec isolation de l'analyse dans des `worker_threads`** : un
  `worker_thread` partage le processus ; une faille ailleurs dans l'application donne toujours la clé.
- **HSM / KMS** : meilleure garantie (clé non extractible) mais matériel ou service externe ; reste
  possible plus tard derrière l'interface `Signer` du signataire (PKCS#11).
- **Signataire qui relit la base de l'application** : casse la séparation des comptes pour un gain faible.

## Conséquences

- Deux clés maîtresses : celle du signataire (`/etc/lockmaster-signer/master.key` ou credential systemd)
  chiffre les clés de signature ; celle de l'application chiffre ses autres secrets (OIDC, SMTP, TOTP).
- La table `signing_key` de l'application ne contient plus que les parties publiques ; les clés privées
  et le journal de signatures sont dans la base du signataire (`/var/lib/lockmaster-signer/signer.db`).
- `lockmaster init` initialise aussi le signataire (sous son compte) ; `lockmaster doctor` vérifie la séparation
  (l'application ne peut pas lire `/var/lib/lockmaster-signer`, le socket a les bons droits).
- Test e2e obligatoire : sous le compte de l'application, toute lecture des fichiers du signataire
  échoue ; une demande de signature non conforme (mauvais `Origin`, contenu arbitraire) est refusée
  et journalisée.
