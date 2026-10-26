// Description d'un paquet lu dans son contenu (docs/03 §1), commune aux trois formats. L'identité
// d'un paquet est (dépôt, nom, version, architecture) lue ici, jamais le nom du fichier envoyé (S10).

export type PackageFormatName = 'deb' | 'rpm' | 'apk';

/** Opérateurs de version normalisés : `<<`/`LT`/`<` -> lt, etc. */
export type VersionOperator = 'lt' | 'le' | 'eq' | 'ge' | 'gt';

export interface Relation {
  readonly name: string;
  readonly operator?: VersionOperator;
  readonly version?: string;
  /** Qualificatif d'architecture Debian écrit après le nom (par exemple « native » ou « amd64 »). */
  readonly qualifier?: string;
}

/** Alternatives : une seule suffit (`a | b` en Debian). */
export type RelationGroup = readonly Relation[];

export interface PackageDigests {
  readonly sha256: string;
  readonly sha512: string;
  /** md5 et sha1 : seulement pour la compatibilité des métadonnées publiées (Packages, repodata). */
  readonly sha1: string;
  readonly md5: string;
}

export interface ParsedPackage {
  readonly format: PackageFormatName;
  readonly name: string;
  /** Version complète, telle qu'écrite dans le paquet et validée par la grammaire du format. */
  readonly version: string;
  readonly arch: string;
  readonly size: number;
  readonly digests: PackageDigests;
  /** Champs bruts nécessaires à la régénération des métadonnées, dans l'ordre du paquet. */
  readonly control: Readonly<Record<string, string>>;
  /** Dépendances à satisfaire (Pre-Depends et Depends en Debian), chacune avec ses alternatives. */
  readonly depends: readonly RelationGroup[];
  readonly provides: readonly Relation[];
  readonly conflicts: readonly Relation[];
  /** Remplacements (Replaces Debian, Obsoletes RPM, replaces APK) : signal SEC-02. */
  readonly replaces: readonly Relation[];
  /** Liste des fichiers (RPM) ; non requise pour deb et apk. */
  readonly files?: readonly string[];
  readonly sourceName?: string;
  readonly sourceVersion?: string;
  /** Scripts exécutés à l'installation présents dans le paquet (signal SEC-02). */
  readonly maintainerScripts: readonly string[];
}
