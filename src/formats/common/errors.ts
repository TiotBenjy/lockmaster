// Erreurs des parseurs de formats : codes stables, messages sans donnée brute du paquet (un nom ou un
// champ lu dans un fichier non fiable ne finit ni dans un message ni dans un journal).

import { LockmasterError } from '../../domain/errors.js';

export type FormatErrorCode =
  /** Les données s'arrêtent avant la longueur déclarée ou attendue. */
  | 'FORMAT_TRUNCATED'
  /** Structure ou champ non conforme au format. */
  | 'FORMAT_INVALID'
  /** Une limite de `limits.ts` est dépassée (taille, ratio, nombre d'entrées, mémoire). */
  | 'FORMAT_LIMIT_EXCEEDED'
  /** Algorithme de compression inconnu ou non pris en charge (ADR-0015). */
  | 'FORMAT_UNSUPPORTED_COMPRESSION'
  /** Flux compressé corrompu (données, somme de contrôle, fin prématurée). */
  | 'FORMAT_CORRUPT_STREAM'
  /** Analyse interrompue par l'échéance ou une annulation. */
  | 'FORMAT_ABORTED';

export class FormatError extends LockmasterError {
  declare readonly code: FormatErrorCode;

  constructor(code: FormatErrorCode, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = 'FormatError';
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new FormatError('FORMAT_ABORTED', 'analyse interrompue (échéance ou annulation)');
}
