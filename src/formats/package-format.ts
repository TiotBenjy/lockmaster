// Interface commune aux formats de paquets (CLAUDE.md §SOLID, principe ouvert/fermé) : ajouter un
// format, c'est ajouter une implémentation de `PackageFormat`, sans toucher aux appelants. Chaque
// implémentation passe test/contracts/package-format.contract.ts.

import type { PackageFormatName, ParsedPackage } from '../domain/package.js';
import type { FormatLimits } from './common/limits.js';
import type { ByteSource } from './common/source.js';

export interface ParseOptions {
  readonly limits: FormatLimits;
  readonly signal?: AbortSignal | undefined;
}

/** Flux interne décompressé, envoyé à l'antivirus en plus du fichier brut (SEC-01). */
export interface InnerStream {
  /** Nom stable du flux (`control.tar`, `data.tar`, `payload.cpio`...), jamais tiré du paquet. */
  readonly name: string;
  readonly data: AsyncIterable<Uint8Array>;
}

export interface PackageFormat {
  readonly name: PackageFormatName;
  /** Lit et valide un paquet non fiable ; toute anomalie lève une `FormatError`. */
  parse(source: ByteSource, options: ParseOptions): Promise<ParsedPackage>;
  /**
   * Flux internes décompressés, un par un : chaque flux doit être lu en entier (ou abandonné) avant
   * le suivant. Une erreur pendant la lecture d'un flux est une `FormatError` (jamais « propre »).
   */
  innerStreams(source: ByteSource, options: ParseOptions): AsyncIterable<InnerStream>;
  /** Négatif, nul ou positif ; lève FORMAT_INVALID pour une version invalide. */
  compareVersions(a: string, b: string): number;
}
