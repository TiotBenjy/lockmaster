import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/log.js';
import { LogCapture } from '../helpers/deps.js';

describe('createLogger (SEC-29)', () => {
  it('écrit du JSON avec un horodatage ISO et le niveau en texte', () => {
    const out = new LogCapture();
    createLogger({ level: 'info', format: 'json' }, out).info({ event: 'test.event' }, 'bonjour');
    expect(out.lines[0]).toMatchObject({ level: 'info', event: 'test.event', msg: 'bonjour' });
    expect(String(out.lines[0]?.['time'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('respecte le niveau configuré', () => {
    const out = new LogCapture();
    const logger = createLogger({ level: 'warn', format: 'json' }, out);
    logger.info('ignoré');
    logger.warn('gardé');
    expect(out.lines.map((line) => line['msg'])).toEqual(['gardé']);
  });

  it.each([
    [{ req: { headers: { authorization: 'Bearer lkm_secret' } } }],
    [{ req: { headers: { cookie: '__Host-session=secret' } } }],
    [{ req: { headers: { 'x-csrf-token': 'secret' } } }],
    [{ res: { headers: { 'set-cookie': ['__Host-session=secret'] } } }],
    [{ headers: { authorization: 'Basic secret' } }],
  ])('masque les en-têtes sensibles : %j', (payload) => {
    const out = new LogCapture();
    createLogger({ level: 'info', format: 'json' }, out).info(payload, 'requête');
    expect(out.text()).not.toContain('secret');
    expect(out.text()).toContain('[masqué]');
  });
});
