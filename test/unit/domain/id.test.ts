import { describe, expect, it } from 'vitest';
import { createIdGenerator, isId } from '../../../src/domain/id.js';
import { FakeClock } from '../../fakes/clock.js';
import { FakeRandom } from '../../fakes/random.js';

// Identifiants ULID (docs/05) : 26 caractères Crockford, triables par date de création.

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('identifiants ULID', () => {
  it('produit 26 caractères Crockford dont les 10 premiers codent les millisecondes', () => {
    const clock = new FakeClock(new Date(0x0180_0000_0000));
    const id = createIdGenerator(clock, new FakeRandom('id'))();
    expect(id).toMatch(CROCKFORD);
    // 0x018000000000 ms = 48 bits : « 01G0000000 » en base 32 Crockford.
    expect(id.slice(0, 10)).toBe('01G0000000');
  });

  it('est déterministe avec une horloge et un aléa de test', () => {
    const make = () => createIdGenerator(new FakeClock(new Date('2026-10-29T10:00:00Z')), new FakeRandom('x'))();
    expect(make()).toBe(make());
  });

  it("reste strictement croissant dans la même milliseconde et quand l'horloge recule", () => {
    const clock = new FakeClock(new Date('2026-10-29T10:00:00Z'));
    const next = createIdGenerator(clock, new FakeRandom('mono'));
    const ids = [next(), next(), next()];
    clock.advance(-5_000);
    ids.push(next());
    clock.advance(10_000);
    ids.push(next());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('refuse une date hors de la plage ULID (48 bits)', () => {
    const next = createIdGenerator(new FakeClock(new Date(-1)), new FakeRandom('neg'));
    expect(() => next()).toThrow(expect.objectContaining({ code: 'ID_CLOCK_INVALID' }));
  });

  it('isId reconnaît un identifiant et refuse le reste', () => {
    const id = createIdGenerator(new FakeClock(new Date()), new FakeRandom('ok'))();
    expect(isId(id)).toBe(true);
    for (const value of ['', id.toLowerCase(), `${id}0`, id.replace(/.$/, 'U'), '../etc/passwd']) {
      expect(isId(value)).toBe(false);
    }
  });
});
