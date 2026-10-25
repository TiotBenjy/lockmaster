import { LockmasterError } from '../domain/errors.js';

// Durées de la configuration : "<entier><unité>", unité ms|s|m|h|d (deploy/lockmaster.example.toml).
const DURATION = /^(0|[1-9][0-9]{0,8})(ms|s|m|h|d)$/;
const FACTORS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Convertit une durée de configuration en millisecondes. */
export function parseDuration(input: string): number {
  const match = DURATION.exec(input);
  const amount = match?.[1];
  const factor = match?.[2] === undefined ? undefined : FACTORS[match[2]];
  if (amount === undefined || factor === undefined) {
    throw new LockmasterError(
      'CONFIG_INVALID_DURATION',
      `durée invalide « ${input} » : attendu un entier suivi de ms, s, m, h ou d (ex. "30m")`,
    );
  }
  return Number(amount) * factor;
}
