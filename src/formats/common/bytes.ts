// Lecture indexée vérifiée : avec `noUncheckedIndexedAccess`, `tableau[i]` est `number | undefined`.
// Plutôt que de substituer une valeur par défaut, une lecture hors limites (bogue ou donnée
// incohérente que la validation n'aurait pas arrêtée) lève une erreur typée : fail-closed.
// Une fonction par type de tableau : chaque site d'accès reste monomorphe (boucles des décodeurs).

import { FormatError } from './errors.js';

function outOfBounds(): FormatError {
  return new FormatError('FORMAT_INVALID', 'lecture hors limites');
}

export function at(array: Uint8Array, index: number): number {
  const value = array[index];
  if (value === undefined) throw outOfBounds();
  return value;
}

export function at16(array: Uint16Array, index: number): number {
  const value = array[index];
  if (value === undefined) throw outOfBounds();
  return value;
}

export function at32(array: Uint32Array, index: number): number {
  const value = array[index];
  if (value === undefined) throw outOfBounds();
  return value;
}

export function atInt32(array: Int32Array, index: number): number {
  const value = array[index];
  if (value === undefined) throw outOfBounds();
  return value;
}

export function atNumber(array: readonly number[], index: number): number {
  const value = array[index];
  if (value === undefined) throw outOfBounds();
  return value;
}
