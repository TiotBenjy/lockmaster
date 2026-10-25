# Clés de vérification des outils de build

## `nodejs-release-keys.kbx`

Trousseau des releasers Node.js **actifs**, copié de
`https://github.com/nodejs/release-keys` (`gpg-only-active-keys/pubring.kbx`, branche `main`), le
2026-10-25. Il sert à vérifier `SHASUMS256.txt.asc` de chaque version de Node embarquée
(`packaging/update-pins.sh`, `gpgv`), d'où sont tirées les sommes SHA-256 de `versions.env`.

Mise à jour : quand un nouveau releaser publie une version, recopier le fichier depuis ce même
dépôt, vérifier dans le diff que les empreintes ajoutées sont celles listées dans le README de
`nodejs/node` (section « Release keys »), puis faire relire (CODEOWNERS).

## Grype, nfpm

Pas de clé à conserver : leurs fichiers de sommes sont signés par sigstore (signature sans clé). Le
script vérifie avec `cosign verify-blob` que la signature a été produite par un workflow GitHub
Actions de leur propre dépôt (`--certificate-identity-regexp`, `--certificate-oidc-issuer`).
L'image cosign elle-même est épinglée par digest dans `versions.env`.
