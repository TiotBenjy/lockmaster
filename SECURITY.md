# Politique de sécurité

Lockmaster sert à distribuer des paquets signés à toute une flotte : une faille peut avoir un impact
sur chaque machine cliente. Merci de nous la signaler **en privé**.

*English summary: please report vulnerabilities privately through GitHub's "Report a vulnerability"
button (Security tab). Never open a public issue for a security problem. We acknowledge within
3 business days and coordinate disclosure within 90 days at most.*

## Signaler une vulnérabilité

**N'ouvrez jamais d'issue publique, de discussion ou de pull request pour un problème de sécurité.**

1. Voie privilégiée : onglet **Security** du dépôt, bouton **Report a vulnerability**
   (<https://github.com/TiotBenjy/lockmaster/security/advisories/new>). Le signalement reste visible
   uniquement des mainteneurs.
2. Si cette voie est indisponible : message privé au mainteneur, **TiotBenjy**, via son profil
   GitHub, en demandant un canal confidentiel ; aucun détail technique dans ce premier message.

Merci d'indiquer :
- la version (ou le commit) et le mode d'installation (.deb, .rpm, image Docker ou Podman) ;
- le composant concerné (application, service de signature, serveur de dépôt nginx, CLI, paquets) ;
- les étapes de reproduction ou une preuve de concept minimale ;
- l'impact estimé : ce qu'un attaquant obtient, et avec quels droits de départ ;
- si la faille est déjà connue publiquement ou exploitée.

N'incluez ni secret réel, ni clé privée, ni donnée personnelle dans votre signalement.

## Ce qui se passe ensuite

| Étape | Délai visé |
|---|---|
| Accusé de réception | 3 jours ouvrés |
| Première évaluation (recevable ou non, sévérité CVSS 4.0) | 10 jours ouvrés |
| Correctif publié | critique : 7 jours ; haute : 30 jours ; moyenne : 90 jours ; basse : prochaine version |
| Divulgation coordonnée | à la publication du correctif, au plus tard 90 jours après le signalement, sauf accord contraire |

Nous vous tenons informé à chaque étape. Si vous le souhaitez, vous êtes cité dans l'avis de
sécurité et les notes de version.

## CVE et avis de sécurité

- Chaque vulnérabilité confirmée fait l'objet d'un **avis de sécurité GitHub** (GHSA) et d'une
  **demande de CVE** par cet avis (GitHub est autorité de numérotation CVE).
- L'avis indique les versions touchées, les versions corrigées, la sévérité, les contournements
  possibles et les actions à mener par les exploitants (par exemple une rotation de clé de
  signature, ou la republication des dépôts).
- Les correctifs sont publiés dans une version signée ; les notes de version renvoient à l'avis.

## Périmètre

Sont concernés, par exemple :
- publication d'un paquet sans passer par le pipeline (format, antivirus, règles d'intégrité de la
  flotte, analyse CVE, décision tracée) ;
- contournement du principe des 4 yeux, de la file de revue ou du contrôle d'accès (RBAC, portée par
  dépôt, jetons d'API) ;
- lecture ou usage d'une clé de signature hors du service de signature, signature de contenu
  arbitraire ;
- accès à un dépôt privé sans identifiants, ou à des fichiers hors de l'arborescence publiée ;
- injection (SQL, commande, HTML/XSS), traversée de chemin, SSRF, désérialisation dangereuse ;
- altération indétectable du journal d'audit ;
- faiblesse de la configuration nginx de référence (`deploy/nginx/`) ou des paquets livrés.

Hors périmètre :
- une vulnérabilité **dans un paquet hébergé** par une instance : la signaler à son éditeur ;
- les limites de détection de ClamAV ou de Grype elles-mêmes : la signaler à ces projets ;
- une configuration qui s'écarte de la configuration de référence ou désactive volontairement un
  contrôle documenté ;
- une attaque qui suppose déjà un accès root à l'hôte de l'application ou du signataire ;
- un déni de service par simple volume sans amplification.

## Vulnérabilités dans les dépendances

- Une **CVE déjà publique** dans une dépendance (npm, Node.js embarqué, Grype embarqué, image de base)
  peut être signalée par une issue, avec le modèle « CVE publique dans une dépendance ».
- Si vous pensez qu'elle est **exploitable dans Lockmaster** d'une façon qui n'est pas évidente,
  utilisez la voie privée ci-dessus.

## Versions maintenues

| Version | Correctifs de sécurité |
|---|---|
| Avant la 1.0 | branche principale uniquement |
| 1.x | dernière version mineure |

## Recherche de bonne foi

Nous ne poursuivrons pas une recherche menée de bonne foi qui respecte cette politique : tests sur
votre propre instance uniquement, pas d'accès aux données d'autrui, pas de dégradation de service,
signalement privé et délai raisonnable avant toute divulgation.
