# ADR-0010 : Rôles par groupes locaux et groupes d'annuaire (Active Directory), continuité en cas de panne

- Statut : accepté (exigence du porteur, 2026-10-25)
- Amende : ADR-0006 (LDAP natif n'est plus « option tardive »), `docs/02` §3.4-3.5, `docs/05`

## Contexte

Les rôles (reader, uploader, maintainer, auditor, admin, globaux ou par dépôt) doivent pouvoir être
attribués **par l'annuaire de l'entreprise (Active Directory)**, pour que les arrivées, départs et
changements de poste soient gérés au même endroit que le reste du SI. Mais une panne de l'AD (ou de
l'IdP qui s'appuie dessus) ne doit **pas bloquer** l'exploitation du gestionnaire de dépôts : il faut
pouvoir se connecter, relire la file de revue, publier un correctif urgent.

## Décision

### 1. Les rôles s'attribuent uniquement à des groupes, de deux natures

| Nature | Géré où | Membres | Usage |
|---|---|---|---|
| **Groupe local** | dans l'application (UI/API/CLI) | comptes locaux (et, exceptionnellement, comptes d'annuaire) | secours (« break-glass »), comptes de service, petites équipes hors AD |
| **Groupe d'annuaire** | dans l'AD (ou l'IdP) ; l'application ne fait que **mapper** un groupe AD vers un rôle | comptes d'annuaire | cas nominal |

- Une liaison `group_role` associe un groupe (local ou d'annuaire) à un rôle, **global** ou **limité à
  un dépôt**. Les droits effectifs d'un compte = **union** des rôles de tous ses groupes.
- Plus de rôle porté directement par un compte : tout passe par des groupes (audit et revue plus simples).
- Modifier une liaison donnant `admin` ou `maintainer`, ou la composition d'un groupe local qui en
  porte une, exige les **4 yeux** (SEC-18).

### 2. Connecteurs d'annuaire (interface `DirectoryConnector`)

- **LDAPS vers Active Directory** (`ldapts`) : bind de l'utilisateur pour l'authentification
  (mot de passe vérifié par l'AD, jamais stocké), compte de service en lecture seule pour la résolution
  des groupes ; groupes **imbriqués** résolus par la règle `LDAP_MATCHING_RULE_IN_CHAIN`
  (`(member:1.2.840.113556.1.4.1941:=<DN utilisateur>)`) ; identifiant stable = `objectGUID` (le DN
  peut changer) ; TLS obligatoire (LDAPS 636 ou StartTLS), CA épinglée, plusieurs contrôleurs de
  domaine configurables (bascule automatique) ; comptes désactivés dans l'AD
  (`userAccountControl` bit `ACCOUNTDISABLE`) refusés.
- **OIDC** (Entra ID, ADFS, Keycloak...) : groupes lus dans un claim (`groups`), identité `(iss, sub)`
  (SEC-09).
- Les deux peuvent être actifs ; chaque groupe d'annuaire est rattaché à un connecteur.

### 3. Continuité quand l'annuaire est en panne

| Situation | Comportement |
|---|---|
| Connexion d'un compte **local** | toujours possible (mot de passe local + TOTP obligatoire), indépendamment de l'annuaire |
| Connexion d'un compte **d'annuaire** quand l'AD/l'IdP ne répond pas | refusée : l'application ne vérifie jamais un mot de passe AD elle-même et ne garde aucune empreinte de mot de passe AD (pas d'authentification hors ligne) |
| Sessions web déjà ouvertes de comptes d'annuaire | continuent jusqu'à leur expiration (12 h max) avec les groupes en cache |
| Jetons d'API (CI) de comptes d'annuaire | continuent avec les appartenances en cache **si** leur dernière synchronisation réussie date de moins de `directory.max_staleness` (défaut 72 h) ; au-delà, refusés |
| Synchronisation périodique (toutes les heures) | AD joignable : les appartenances sont rafraîchies, un retrait dans l'AD retire les droits ; AD injoignable : le cache est conservé (dans la limite ci-dessus) et une alerte est émise |
| Désactivation **locale** d'un compte | toujours prioritaire sur l'annuaire (coupe immédiatement sessions et jetons) |

### 4. Comptes de secours (« break-glass »)

- `lockmaster init` crée le premier admin comme **compte local**, membre du groupe local `admins-secours`
  lié au rôle `admin` global.
- Recommandation : 2 comptes de secours nominatifs, MFA obligatoire, mots de passe sous séquestre.
- Chaque connexion d'un compte local membre d'un groupe à rôle `admin`/`maintainer` génère une
  **alerte** (notification à tous les admins) ; l'UI affiche un bandeau « connexion de secours ».
- `security.disable_local_login` ne s'applique **jamais** aux membres de `admins-secours` : il est
  impossible de se priver de l'accès de secours par configuration.
- `lockmaster doctor` signale l'absence d'au moins un compte de secours actif avec MFA.

### 5. MFA selon le connecteur (décision du porteur, 2026-10-25)

La MFA reste obligatoire pour tout compte qui détient `admin` ou `maintainer` (globalement ou sur un
dépôt). Sa source dépend de l'origine du compte :

| Compte | MFA exigée |
|---|---|
| local (dont `admins-secours`) | TOTP de l'application (+ codes de récupération) |
| annuaire via **LDAPS** | TOTP de l'application : un bind LDAP ne fournit aucun second facteur |
| annuaire via **OIDC** | MFA de l'IdP, **prouvée** par le jeton d'identité : `amr` contient une valeur de `auth.oidc.mfa_amr` (défaut `["mfa", "otp", "hwk", "swk", "sc"]`) ou `acr` figure dans `auth.oidc.mfa_acr` ; l'authentification date de moins de `auth.oidc.mfa_max_age` (paramètre `max_age` envoyé, `auth_time` vérifié) |

- Si la preuve est absente, invalide ou trop ancienne : **repli sur le TOTP de l'application**
  (inscription obligatoire au premier besoin), jamais un accès sans second facteur.
- `auth.oidc.mfa = "app"` impose le TOTP de l'application même aux comptes OIDC (IdP qui ne publie
  pas `amr`/`acr` fiables).
- La session enregistre l'origine (`session.mfa_method` : `totp`, `recovery` ou `idp`), reprise
  dans l'audit de connexion.

## Justification

- Le cas nominal suit l'AD (cycle de vie des comptes centralisé) ; le cas dégradé reste opérable sans
  affaiblir l'authentification (pas de mot de passe AD en cache).
- Le cache borné des appartenances évite de casser la CI lors d'une panne courte, sans laisser un
  ancien employé garder ses droits indéfiniment.

## Conséquences

- Schéma (`docs/05`) : `local_group`, `local_group_member`, `directory_connector` (config en
  `lockmaster.toml`), `directory_group`, `account_directory_group` (cache daté), `group_role` ; suppression
  de `account.global_role` et de `role_binding`.
- API/UI : gestion des groupes locaux, du mapping des groupes d'annuaire, état des connecteurs.
- Tests : panne simulée de l'AD (conteneur Samba AD ou OpenLDAP avec schéma AD en e2e) : comptes locaux
  connectés, comptes d'annuaire refusés, jetons valides jusqu'à `max_staleness` puis refusés, retrait
  d'un groupe dans l'annuaire propagé à la synchronisation suivante.
