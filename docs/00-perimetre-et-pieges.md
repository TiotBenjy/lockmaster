# 00 : Périmètre fonctionnel et pièges à éviter

Ce document fixe **ce que fait le produit** et la liste des **pièges** qu'un gestionnaire de dépôts
avec scan de sécurité rencontre classiquement. Chaque piège a un identifiant stable (S = pipeline de
sécurité, G = signature et intégrité, A = authentification et audit, R = robustesse), repris dans
les autres documents, et la réponse qui lui est apportée.

## 1. Ce que fait le produit

Gestionnaire de dépôts privés APT (.deb), RPM et APK, avec interface web, RBAC et pipeline de
sécurité : upload -> validation de format -> ClamAV -> règles d'intégrité de la flotte -> Grype
(CVE, enrichi EPSS/KEV) -> politique par sévérité (block/review/warn/allow) -> publication signée.
Fonctions attendues :
- import de paquets depuis des dépôts amont avec résolution des dépendances transitives, miroir
  planifié ;
- canaux et promotion entre canaux, file de revue pour l'équipe sécurité, principe des 4 yeux ;
- snapshots, rétention, retour arrière ;
- statistiques de téléchargement (journaux nginx), notifications e-mail et webhooks (Slack, Teams) ;
- `/metrics`, audit chaîné et exportable ;
- re-analyse CVE quotidienne à partir des SBOM stockés ;
- mode air-gap (bundles de bases de vulnérabilités et de paquets signés).

## 2. Contraintes de conception

| Contrainte | Conséquence |
|---|---|
| Simple à déployer et à maintenir | une application (un processus + son signataire) et un serveur de dépôt nginx standard ; un seul fichier de configuration ; `.deb`, `.rpm` et image OCI (Docker et Podman) |
| Une seule source de vérité | SQLite ; tout le reste (arborescence publiée, métadonnées) est dérivé et régénérable |
| Aucun outil système sur du contenu non fiable | parseurs et générateurs natifs en TypeScript (pas de reprepro, createrepo_c, apk-tools, dpkg, rpm, gpg à l'exécution) |
| Installation sans étape manuelle risquée | `lockmaster init` en local, pas d'assistant web de premier lancement |

## 3. Pièges du pipeline de sécurité

| # | Piège | Réponse |
|---|---|---|
| S1 | Une option « forcer » censée être réservée aux admins mais mal contrôlée permet de sauter la revue | aucune option « forcer » ; permissions déclarées par route ; machine à états unique (`docs/04`) |
| S2 | Le serveur de dépôt expose tout le stock de paquets, y compris ceux en attente de revue ou en erreur | seules des générations complètes de paquets approuvés sont envoyées vers le serveur de dépôt (ADR-0003, ADR-0008) |
| S3 | Une fonction d'installation qui exécute des commandes sur l'hôte et dépose des paquets sans scan | fonction absente ; l'import amont passe par le pipeline complet (ADR-0006) |
| S4 | Antivirus en « fail-open » (erreur, timeout, binaire absent = succès) et antivirus aveugle : envoyer un `.deb` ou un `.rpm` brut à clamd ne détecte rien, ClamAV n'ouvre ni l'archive `ar` ni le conteneur RPM | fail-closed partout ; chaque flux interne décompressé est analysé (SEC-01, `docs/04`) |
| S5 | Analyse CVE en « fail-open » ; paquet sans résultat d'analyse approuvé par défaut | fail-closed ; pas de résultat = pas de publication (invariant 1) |
| S6 | Politique par défaut qui ne bloque que le critique et n'envoie rien en revue | politique par défaut avec règles `review` (`docs/04` §3) |
| S7 | Pas de principe des 4 yeux ; une approbation traitable deux fois | 4 yeux imposés par contrainte SQL ; transitions d'état vérifiées (`docs/05`) |
| S8 | Un maintainer lève seul un blocage ; état enregistré « accepté » avant que la publication réussisse | levée de blocage soumise aux 4 yeux ; état mis à jour dans la transaction qui constate le résultat |
| S9 | Champs du paquet (nom, version, arch) utilisés pour construire des chemins : traversée de répertoire | blobs nommés par sha256 ; chemins publiés calculés et validés (invariant 4) |
| S10 | Identité de paquet usurpable (doublon testé sur le nom de fichier envoyé) | identité = (dépôt, nom, version, arch) lue dans le contenu ; 409 si le sha256 diffère (`docs/04` §2.1) |
| S11 | Une CVE bloquante découverte après publication marque le paquet « à revoir » mais il reste servi | option `retire` qui retire réellement le paquet du canal et republie (`docs/04` §5) |

## 4. Pièges de signature et d'intégrité

| # | Piège | Réponse |
|---|---|---|
| G1 | Index APK non signé | APKINDEX signé RSA256 (`docs/03` §4.3) |
| G2 | Paquets RPM non signés et instructions client avec `gpgcheck=0` | RPM et APK re-signés (mode `resign`) ; `gpgcheck=1` et `repo_gpgcheck=1` (`docs/03` §3.4) |
| G3 | Échec de signature des métadonnées ignoré | une génération n'est basculée qu'après vérification de ses signatures (ADR-0003) |
| G4 | Clé privée sans phrase de passe, montée dans le conteneur nginx exposé | clés uniquement dans le signataire, chiffrées ; aucune clé sur le serveur de dépôt (ADR-0008, ADR-0009) |
| G5 | Signature amont absente ou illisible traitée comme un avertissement | signature amont obligatoire avec trousseau explicite (invariant 8) |
| G6 | Hash attendu absent considéré comme valide ; signatures des paquets envoyés non vérifiées | hash obligatoire ; vérification de signature réelle (`docs/03`) |

## 5. Pièges d'authentification, d'autorisation et d'audit

| # | Piège | Réponse |
|---|---|---|
| A1 | Jeton de session dans `localStorage` (volable par XSS), CORS ouvert avec identifiants | session serveur en cookie `__Host-`, pas de CORS (ADR-0004) |
| A2 | Rôle lu dans le jeton : un admin rétrogradé reste admin ; changement de mot de passe sans révocation | rôle relu en base à chaque requête ; révocation au changement de mot de passe ou de rôle (`docs/02` §3.4) |
| A3 | Rôles personnalisés et permissions déclarés mais jamais appliqués ; pas de portée par dépôt | 5 rôles réellement appliqués, portée par dépôt, attribués par groupes (ADR-0010) |
| A4 | Pas de jetons d'API pour la CI ; LDAP/OIDC annoncés mais absents | jetons d'API à portée et expiration ; OIDC et LDAPS Active Directory (ADR-0010) |
| A5 | Assistant d'installation public, réouvrable, qui renvoie des erreurs SQL brutes | pas d'assistant web : `lockmaster init` en local |
| A6 | MFA sans limite de débit, codes TOTP rejouables, désactivation avec le seul mot de passe | TOTP anti-rejeu, limite de débit, MFA obligatoire pour admin et maintainer (`docs/02` §3.3) |
| A7 | Audit en fichiers modifiables, sans chaîne de hachage, lisible par tous | audit chaîné en base, triggers append-only, points de contrôle signés, accès `audit:read` (`docs/05`) |
| A8 | Secrets de repli (chiffrement retombant sur une valeur par défaut) | clé maîtresse dédiée obligatoire, aucun repli (`docs/02` §3.3) |
| A9 | Interrupteurs de désactivation (signature des webhooks, antivirus, hash) | aucun interrupteur de ce type n'existe (CLAUDE.md) |
| A10 | Contrôle de licence par secret symétrique fourni par l'opérateur | pas de système de licence |

## 6. Pièges de robustesse

| # | Piège | Réponse |
|---|---|---|
| R1 | Incohérences entre base et fichiers (résultat de publication ignoré, fichiers orphelins, scripts de réparation nécessaires) | SQLite seule vérité ; publication par générations ; ramassage cohérent (ADR-0002, ADR-0003) |
| R2 | Concurrence : régénération d'index sans verrou, uploads simultanés qui s'écrasent, promotion par nom au lieu de la version exacte | un seul écrivain par canal, file de jobs en base, promotion par identifiant de version (`docs/01` §4) |
| R3 | Haute disponibilité par élection de leader fragile et jobs en mémoire perdus au redémarrage | pas de HA active en v1 ; jobs persistants avec reprise (ADR-0002) |
| R4 | Limite de taille d'upload configurée mais jamais appliquée | limites appliquées et testées (`[limits]` de la configuration) |
| R5 | Fonctions annexes qui alourdissent sans servir (inventaire de flotte par SSH, conformité, générateur de Dockerfile) | hors périmètre (ADR-0006) |
