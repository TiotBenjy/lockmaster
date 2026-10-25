import { describe, expect, it } from 'vitest';
import { parseListenAddress } from '../../../src/config/address.js';
import { LockmasterError } from '../../../src/domain/errors.js';

describe('parseListenAddress', () => {
  it.each([
    [':8080', { host: '0.0.0.0', port: 8080 }],
    ['127.0.0.1:9090', { host: '127.0.0.1', port: 9090 }],
    ['[::1]:8443', { host: '::1', port: 8443 }],
    ['[::]:80', { host: '::', port: 80 }],
    ['lockmaster.internal:8080', { host: 'lockmaster.internal', port: 8080 }],
    ['localhost:1', { host: 'localhost', port: 1 }],
    [':65535', { host: '0.0.0.0', port: 65535 }],
  ])('%s', (input, expected) => {
    expect(parseListenAddress(input)).toEqual(expected);
  });

  it.each([
    '',
    '8080',
    ':0',
    ':65536',
    ':080',
    'host:',
    '::1:8080',
    '[::1]',
    '[zz]:80',
    '999.1.1.1:80',
    'bad_host:80',
    '-host:80',
    'host :80',
    `${'a'.repeat(254)}:80`,
  ])('refuse « %s »', (input) => {
    try {
      parseListenAddress(input);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LockmasterError);
      expect((error as LockmasterError).code).toBe('CONFIG_INVALID_ADDRESS');
    }
  });
});
