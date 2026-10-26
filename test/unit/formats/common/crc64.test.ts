import { describe, expect, it } from 'vitest';
import { Crc64 } from '../../../../src/formats/common/xz/crc64.js';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).reverse().toString('hex');

describe('Crc64 (CRC-64/XZ)', () => {
  it('donne la valeur de contrôle du catalogue pour « 123456789 » et 0 pour le vide', () => {
    const crc = new Crc64();
    crc.update(Buffer.from('123456789'));
    expect(hex(crc.digest())).toBe('995dc9bbdf1939fa');
    expect(hex(new Crc64().digest())).toBe('0000000000000000');
  });

  it('ne dépend pas du découpage des données', () => {
    const whole = new Crc64();
    whole.update(Buffer.from('lockmaster'));
    const parts = new Crc64();
    parts.update(Buffer.from('lock'));
    parts.update(Buffer.from('master'));
    expect(parts.digest()).toEqual(whole.digest());
  });
});
