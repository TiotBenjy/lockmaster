// Limites de lecture des contenus non fiables (invariant 2, docs/02 §3.2, SEC-22). Tout parseur de
// src/formats/ reçoit un objet `FormatLimits` ; aucune lecture ni décompression n'est sans borne.

import { FormatError } from './errors.js';

const KiB = 1024;
const MiB = 1024 * KiB;

export interface FormatLimits {
  /** Taille maximale d'un paquet (`http.max_upload_bytes`). */
  readonly maxPackageBytes: number;
  /** Taille décompressée maximale d'un membre de contrôle (control.tar, contrôle apk). */
  readonly maxControlBytes: number;
  /** Ratio maximal sortie / entrée d'un flux décompressé. */
  readonly maxDecompressionRatio: number;
  /**
   * Sortie toujours permise quel que soit le ratio : une archive tar vide fait 10 Kio et se
   * compresse en quelques dizaines d'octets, ce qui dépasse 100:1 sans être une bombe.
   */
  readonly ratioFloorBytes: number;
  /** Nombre maximal d'entrées d'une archive de contrôle (tar, ar). */
  readonly maxArchiveEntries: number;
  /** Taille maximale d'un champ texte de contrôle. */
  readonly maxFieldBytes: number;
  /** Taille maximale du texte de contrôle complet (`control`, `.PKGINFO`). */
  readonly maxControlTextBytes: number;
  /** En-tête RPM : nombre maximal d'entrées d'index. */
  readonly rpmMaxIndexEntries: number;
  /** En-tête RPM : taille maximale de la zone de données. */
  readonly rpmMaxStoreBytes: number;
  /** Nombre maximal de fichiers listés par un RPM. */
  readonly rpmMaxFiles: number;
  /** Fenêtre zstd maximale (log2), passée à `ZSTD_d_windowLogMax` (SEC-22). */
  readonly zstdWindowLog: number;
  /** Dictionnaire xz maximal (preset -9 d'xz, ADR-0015). */
  readonly xzMaxDictionaryBytes: number;
}

export const DEFAULT_LIMITS: Readonly<FormatLimits> = Object.freeze({
  maxPackageBytes: 2048 * MiB,
  maxControlBytes: 10 * MiB,
  maxDecompressionRatio: 100,
  ratioFloorBytes: MiB,
  maxArchiveEntries: 1000,
  maxFieldBytes: 64 * KiB,
  maxControlTextBytes: MiB,
  rpmMaxIndexEntries: 65_536,
  rpmMaxStoreBytes: 64 * MiB,
  rpmMaxFiles: 500_000,
  zstdWindowLog: 27,
  xzMaxDictionaryBytes: 64 * MiB,
});

/**
 * Durée maximale d'analyse d'un paquet. Les parseurs testent un `AbortSignal` entre deux étapes,
 * mais un décodage qui ne rend jamais la main à la boucle d'événements ne voit pas un minuteur se
 * déclencher : l'échéance est imposée par le pool de workers (`worker.terminate()` depuis le fil
 * principal, docs/01 §4), le signal ne sert qu'à l'annulation coopérative.
 */
export const PARSE_TIMEOUT_MS = 30_000;

/**
 * Octets compressés minimum par flux concaténé (xz, bzip2) : un flux vide coûte du calcul sans
 * produire de sortie, donc sans être vu par le ratio. Un flux réel fait bien plus de 1 Kio ; les
 * `FREE_STREAMS` premiers flux sont admis quelle que soit leur taille.
 */
export const MIN_BYTES_PER_STREAM = 1024;
const FREE_STREAMS = 8;

/** Lève FORMAT_LIMIT_EXCEEDED si `streams` flux pour `consumedBytes` octets lus est excessif. */
export function checkStreamCount(streams: number, consumedBytes: number): void {
  if (streams > FREE_STREAMS + Math.floor(consumedBytes / MIN_BYTES_PER_STREAM)) {
    throw new FormatError('FORMAT_LIMIT_EXCEEDED', 'trop de flux concaténés pour la taille des données');
  }
}

/**
 * Sortie autorisée pour un flux de `compressedBytes` octets : ratio maximal, au moins le plancher,
 * jamais plus que le plafond de l'usage (`ceiling`, par exemple `maxControlBytes`).
 */
export function decompressionBudget(limits: FormatLimits, compressedBytes: number, ceiling: number): number {
  const byRatio = Math.max(limits.ratioFloorBytes, compressedBytes * limits.maxDecompressionRatio);
  return Math.min(ceiling, byRatio);
}

/** Compteur de sortie : lève `FORMAT_LIMIT_EXCEEDED` dès que le budget est dépassé. */
export class OutputMeter {
  readonly budget: number;
  #total = 0;

  constructor(budget: number) {
    this.budget = budget;
  }

  get total(): number {
    return this.#total;
  }

  add(bytes: number): void {
    this.#total += bytes;
    if (this.#total > this.budget) {
      throw new FormatError('FORMAT_LIMIT_EXCEEDED', `données décompressées au-delà de ${this.budget} octets`);
    }
  }
}
