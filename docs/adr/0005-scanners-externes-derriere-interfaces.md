# ADR-0005 : Scanners externes derrière des interfaces, analyse CVE par SBOM

- Statut : accepté
- Date : 2026-10-19

## Décision

```ts
export interface MalwareScanner {
  scan(input: NodeJS.ReadableStream, size: number, signal: AbortSignal): Promise<MalwareResult>;
  health(signal: AbortSignal): Promise<void>;
  signatureVersion(signal: AbortSignal): Promise<string>;
}

export interface VulnScanner {
  /** Analyse un SBOM CycloneDX décrivant le paquet (purl + distro), pas le binaire. */
  scan(sbom: CycloneDxBom, signal: AbortSignal): Promise<Finding[]>;
  dbStatus(signal: AbortSignal): Promise<VulnDbStatus>;
  updateDb(signal: AbortSignal): Promise<void>;
}
```

- **ClamAV** : protocole `clamd` `zINSTREAM` sur socket Unix ou TCP, implémenté en TS avec
  `node:net` (~150 lignes, tests contre un vrai clamd en conteneur + fichier EICAR).
  Pas de `clamscan` en repli : si clamd est indisponible, le pipeline **échoue fermé**
  (paquet en attente, jamais publié) et l'état de santé passe à `degraded`.
  **ClamAV n'ouvre ni les `.deb` ni les `.rpm`** (vérifié, `docs/11` §3) : Lockmaster lui envoie les flux
  internes décompressés (control/data tar, payload cpio, membres gzip), voir `docs/04` §2.3.
  Transport : socket Unix de préférence ; TCP seulement en local ou via tunnel TLS (clamd n'a pas
  d'authentification et accepte `SHUTDOWN`). Canari périodique par format (SEC-14).
- **Grype** : binaire épinglé (version + SHA-256 vérifiés au build du paquet/image, jamais
  `curl | sh`), lancé avec `child_process.execFile` (**jamais** `exec`, jamais `shell: true`),
  arguments fixes, `-o json`, timeout + `AbortSignal`, sortie limitée en taille, environnement
  minimal **reconstruit** : `GRYPE_DB_CACHE_DIR`, `GRYPE_DB_AUTO_UPDATE=false`,
  `GRYPE_CHECK_FOR_APP_UPDATE=false`, `GRYPE_DB_VALIDATE_AGE=true`, `GRYPE_DB_UPDATE_URL` épinglé, et
  `HOME`/`XDG_CONFIG_HOME` + répertoire courant pointant vers un répertoire **vide** appartenant à Lockmaster :
  Grype charge sinon `./.grype.yaml`, `~/.grype.yaml` ou `$XDG_CONFIG_HOME/grype/config.yaml`, dont une
  règle `ignore:` masquerait des vulnérabilités (vérifié dans sa documentation, SEC-15). L'entrée est un SBOM CycloneDX généré par Lockmaster à partir des
  métadonnées du paquet (purl `pkg:deb/debian/openssl@3.0.11-1?arch=amd64&distro=debian-12`),
  ce qui rend le re-matching quotidien de tout le catalogue rapide, sans relire les binaires.
  Les mises à jour de base sont explicites (`grype db update` planifié, ou import hors-ligne).
- **KEV (CISA)** et **EPSS (FIRST)** : téléchargés par Lockmaster, stockés en base, utilisés par
  le moteur de politique. Import hors-ligne : `lockmaster feeds import <bundle.tar.zst>`.

## Conséquences

- Les deux interfaces ont des implémentations factices (`test/fakes/`) pour les tests unitaires.
- Un scanner OSV natif (bases OSV hors-ligne par écosystème) pourra être ajouté plus tard
  sans toucher au pipeline.
