import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../fakes/clock.js';
import { FakeRandom } from '../../fakes/random.js';

describe('FakeClock', () => {
  it("renvoie l'instant fixé, puis avance sur demande", () => {
    const clock = new FakeClock(new Date('2026-10-25T10:00:00Z'));
    expect(clock.now().toISOString()).toBe('2026-10-25T10:00:00.000Z');
    clock.advance(90_000);
    expect(clock.now().toISOString()).toBe('2026-10-25T10:01:30.000Z');
  });

  it("renvoie une copie : modifier la date reçue ne change pas l'horloge", () => {
    const clock = new FakeClock(new Date('2026-10-25T10:00:00Z'));
    clock.now().setUTCFullYear(2000);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});

describe('FakeRandom', () => {
  it('produit la même suite pour la même graine et une suite différente sinon', () => {
    const a = new FakeRandom('graine');
    const b = new FakeRandom('graine');
    const c = new FakeRandom('autre');
    const first = a.bytes(48);
    expect(first).toHaveLength(48);
    expect(b.bytes(48)).toEqual(first);
    expect(c.bytes(48)).not.toEqual(first);
  });

  it('ne répète pas les mêmes octets entre deux appels', () => {
    const random = new FakeRandom('graine');
    expect(random.bytes(16)).not.toEqual(random.bytes(16));
  });
});
