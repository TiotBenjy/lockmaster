# ADR-0012 : Clé maîtresse transmise par LoadCredential, chiffrement laissé à l'opérateur

- Statut : proposé
- Date : 2026-10-25

## Contexte

SEC-29 (`docs/11`) demande que la clé maîtresse soit « livrée par `LoadCredentialEncrypted=` quand
disponible ». Toutes les distributions supportées (Debian 12 et 13, EL 9 et 10) ont systemd >= 252,
donc la fonction existe partout. Mais :
- le fichier chiffré se produit avec `systemd-creds encrypt`, et `lockmaster init` ne peut pas le
  lancer : seuls `grype` et `rsync` sont des binaires externes autorisés (invariant 3) ;
- la clé n'existe pas encore au postinstall des paquets : `lockmaster init` la crée ensuite.

Jusqu'ici la clé était un fichier `root:lockmaster` 0440 lu directement par le service, donc lisible
par tout processus du compte `lockmaster`, y compris hors de son unité (piège A8 : pas de secret de
repli, mais pas non plus de protection au repos).

## Décision

Pour les paquets .deb et .rpm :
- `lockmaster init` (lancé en root) crée la clé maîtresse de l'application en `root:root` 0400 ;
- `lockmaster.service` la reçoit par `LoadCredential=master.key:/etc/lockmaster/master.key`, et
  `LOCKMASTER__SECURITY__MASTER_KEY_FILE=%d/master.key` pointe le service vers son dossier de
  credentials ;
- le chiffrement est une étape de l'opérateur : le paquet livre un drop-in d'exemple
  (`/usr/share/doc/lockmaster/examples/master-key-credential.conf`, `LoadCredential=` remis à vide
  puis `LoadCredentialEncrypted=`), et `lockmaster init` l'indique.

Les conteneurs ne changent pas (secret monté lisible par l'UID 10001).

## Justification

- La clé n'est plus lisible par le compte `lockmaster` hors de son unité : un shell obtenu sous ce
  compte (autre processus, `sudo -u lockmaster`) ne la lit pas.
- Le passage au chiffrement ne change ni le chemin vu par le service, ni le code : le drop-in suffit.
- Aucune exception à l'invariant 3.
- Vérifié sous systemd (Debian 13) : service actif et `/healthz` avec `LoadCredential`, puis avec
  `LoadCredentialEncrypted` et la clé en clair retirée.

## Alternatives écartées

- Clé `root:lockmaster` 0440 lue directement, chiffrement en exemple seulement : la clé reste lisible
  par tout le compte `lockmaster`.
- Exception à l'invariant 3 pour que `lockmaster init` lance `systemd-creds` : ouvre une seconde voie
  d'exécution de binaire en root pour un gain limité à l'automatisation d'une commande.

## Conséquences

- `lockmaster serve` lancé hors de l'unité (sous le compte `lockmaster`) ne lit plus la clé : le
  service se démarre par `systemctl`. Une clé absente fait échouer l'unité (code 243, fail closed) et
  non le code 78 de `serve` : `RestartPreventExitStatus=78` ne joue pas, le redémarrage s'arrête à
  `StartLimitBurst`.
- La clé du signataire recevra le même traitement en M2, quand `lockmaster init` initialisera le
  signataire (`docs/09`).
- `lockmaster doctor` (M9) signalera une clé en clair sans drop-in de chiffrement.
- Documents mis à jour : `docs/02` (§3.3), `docs/08` (§1 et arborescence), `docs/09` (M2),
  `docs/11` (SEC-29), `deploy/lockmaster.example.toml`. Tests : `test/security/SEC-07-init-root.test.ts`,
  `test/unit/packaging/systemd-units.test.ts`.
