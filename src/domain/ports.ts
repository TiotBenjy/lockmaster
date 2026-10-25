// Ports élémentaires injectés par l'objet Deps (docs/01 §6) : aucun code ne lit l'heure ni l'aléa
// directement, pour que les tests restent déterministes (docs/10).

/** Source de l'heure courante. */
export interface Clock {
  now(): Date;
}

/** Source d'aléa cryptographique. */
export interface RandomSource {
  bytes(length: number): Uint8Array;
}
