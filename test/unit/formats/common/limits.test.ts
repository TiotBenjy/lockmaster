import { describe, expect, it } from 'vitest';
import { FormatError } from '../../../../src/formats/common/errors.js';
import { DEFAULT_LIMITS, decompressionBudget, OutputMeter } from '../../../../src/formats/common/limits.js';

const MiB = 1024 * 1024;

describe('limites par défaut (docs/02 §3.2)', () => {
  it('reprennent les valeurs documentées', () => {
    expect(DEFAULT_LIMITS).toMatchObject({
      maxPackageBytes: 2 * 1024 * MiB,
      maxControlBytes: 10 * MiB,
      maxDecompressionRatio: 100,
      maxArchiveEntries: 1000,
      maxFieldBytes: 64 * 1024,
      maxControlTextBytes: MiB,
      rpmMaxIndexEntries: 65_536,
      rpmMaxStoreBytes: 64 * MiB,
      rpmMaxFiles: 500_000,
      zstdWindowLog: 27,
      xzMaxDictionaryBytes: 64 * MiB,
    });
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
  });
});

describe('decompressionBudget', () => {
  it('autorise au plus ratio x taille compressée', () => {
    expect(decompressionBudget(DEFAULT_LIMITS, 50 * MiB, Number.POSITIVE_INFINITY)).toBe(5000 * MiB);
  });

  it('garde un plancher pour les très petits flux (archive tar vide de 10 Kio)', () => {
    expect(decompressionBudget(DEFAULT_LIMITS, 40, Number.POSITIVE_INFINITY)).toBe(DEFAULT_LIMITS.ratioFloorBytes);
  });

  it("ne dépasse jamais le plafond de l'usage", () => {
    expect(decompressionBudget(DEFAULT_LIMITS, 5 * MiB, DEFAULT_LIMITS.maxControlBytes)).toBe(10 * MiB);
  });
});

describe('OutputMeter', () => {
  it('compte la sortie et lève FORMAT_LIMIT_EXCEEDED au premier octet de trop', () => {
    const meter = new OutputMeter(100);
    meter.add(60);
    meter.add(40);
    expect(meter.total).toBe(100);
    let caught: unknown;
    try {
      meter.add(1);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FormatError);
    expect((caught as FormatError).code).toBe('FORMAT_LIMIT_EXCEEDED');
  });
});
