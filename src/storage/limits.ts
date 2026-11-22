import { LockmasterError } from '../domain/errors.js';

/**
 * Valide la limite de taille d'une écriture de blob : un entier positif sûr. Une limite NaN, infinie ou
 * négative laisserait passer un flux de taille illimitée (`taille > NaN` est toujours faux).
 */
export function assertMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new LockmasterError('BLOB_INVALID_LIMIT', 'limite de taille de blob invalide');
  }
}
