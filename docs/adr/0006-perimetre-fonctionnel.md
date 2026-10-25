# ADR-0006 : Périmètre fonctionnel : ce qu'on garde, simplifie, abandonne

- Statut : accepté, amendé par ADR-0010 (LDAPS Active Directory natif dès M6)
- Date : 2026-10-19

Voir le périmètre et les pièges dans `docs/00-perimetre-et-pieges.md`.

## Fonctions de base

Hébergement DEB/RPM/APK dans une instance · scan ClamAV bloquant · scan CVE avec politique
block/review/warn/allow (CVSS, EPSS, KEV) · file de revue et décisions motivées · re-matching
CVE quotidien du catalogue · signature automatique des métadonnées · import depuis dépôts amont
avec vérification de signature et résolution de dépendances · miroir planifié filtré ·
promotion entre canaux (ex. `testing` -> `stable`) avec approbation · snapshots et rollback ·
rétention · RBAC 5 rôles · journal d'audit + export · MFA TOTP · statistiques de
téléchargement · santé + `/metrics` Prometheus · notifications (e-mail, webhook générique
Slack/Teams/Mattermost) · page « configuration client » · mode air-gap (import/export de
bundles de bases de sécurité).

## Fonctions souvent absentes ou inopérantes ailleurs, exigées ici (`docs/00` §3 à §5)

Signature de l'APKINDEX et (re)signature des paquets RPM et APK · jetons d'API à portée
pour la CI · OIDC et LDAPS Active Directory (ADR-0010) ·
portée des rôles par dépôt · principe des 4 yeux · audit chaîné et vérifiable · retrait effectif
d'un paquet publié quand une nouvelle CVE bloquante apparaît.

## Simplifié

- Rôles personnalisés (piège A3) -> 5 rôles fixes **+ portée par dépôt**, attribués par groupes
  locaux ou groupes d'annuaire (ADR-0010).
- LDAP -> **amendé par ADR-0010** : connecteur LDAPS natif vers Active Directory dès M6, à côté
  d'OIDC, avec groupes locaux de secours pour qu'une panne de l'annuaire ne bloque pas l'exploitation.
- Modèles d'e-mails éditables en UI -> templates embarqués surchargeables par fichier.
- Webhooks entrants GitHub/KEV -> remplacés par un rafraîchissement planifié des flux
  (KEV et EPSS sont publics et téléchargeables).
- Réglages dispersés entre fichiers chiffrés et variables d'environnement -> un fichier `lockmaster.toml` + secrets
  par fichier (`*_file`) ; réglages métier modifiables en UI stockés en base.

## Abandonné (hors périmètre)

- Fonctions « flotte » (inventaire de machines clientes par SSH avec mot de passe sudo stocké,
  conformité CIS, jobs d'installation à distance) : un gestionnaire de dépôt ne doit pas
  détenir d'accès root à la flotte. Hors sujet et risque majeur.
- Bouton « Télécharger depuis Internet » qui fait du SSH vers l'**hôte Docker** pour y lancer
  `apt` : remplacé par l'import amont natif.
- Mécanisme de licence et code de gating (le projet est sous licence MIT).
- Migration depuis un autre gestionnaire de dépôts : hors périmètre ; les paquets existants sont
  réimportés par l'upload ou l'import amont, donc repassent par le pipeline complet.

## Reporté après la v1

- Cible de publication S3 (`publish/targets/s3.ts`) : les cibles `local` et `rsync` couvrent la v1.
  L'interface `PublishTarget` et SEC-26 restent écrits pour l'accueillir sans modifier l'existant.
- Génération de Dockerfile en UI (remplacée par la page « configuration client » qui donne
  les snippets `apt`/`dnf`/`apk`, y compris pour un Dockerfile).
