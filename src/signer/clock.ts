import type { Clock } from '../domain/ports.js';

// Horloge système du signataire : seule lecture directe de l'heure dans src/signer/ (le signataire
// n'importe pas src/app.ts). Les tests injectent une horloge déterministe à la place.
export const signerSystemClock: Clock = { now: () => new Date() };
