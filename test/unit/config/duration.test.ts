import { describe, expect, it } from 'vitest';
import { parseDuration } from '../../../src/config/duration.js';
import { LockmasterError } from '../../../src/domain/errors.js';

describe('parseDuration', () => {
  it.each([
    ['0s', 0],
    ['250ms', 250],
    ['30s', 30_000],
    ['15m', 900_000],
    ['12h', 43_200_000],
    ['5d', 432_000_000],
  ])('%s -> %i ms', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each(['', '30', 'm', '1.5h', '-1s', ' 30s', '30s ', '30 s', '30S', '1w', '030s', '1e3s', '99999999999999d'])(
    'refuse « %s » avec une erreur typée',
    (input) => {
      expect(() => parseDuration(input)).toThrow(LockmasterError);
      try {
        parseDuration(input);
      } catch (error) {
        expect((error as LockmasterError).code).toBe('CONFIG_INVALID_DURATION');
      }
    },
  );
});
