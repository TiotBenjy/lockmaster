import { Writable } from 'node:stream';
import type { Deps } from '../../src/app.js';
import { type Config, configSchema } from '../../src/config/schema.js';
import { createLogger } from '../../src/log.js';
import { FakeClock } from '../fakes/clock.js';
import { FakeRandom } from '../fakes/random.js';

export const MINIMAL_CONFIG_INPUT = {
  server: { public_url: 'https://lockmaster.example.com', data_dir: '/var/lib/lockmaster' },
  publish: { targets: [{ name: 'local', kind: 'local', path: '/srv/lockmaster-repo', public_url: 'https://repo' }] },
};

export function testConfig(patch: Record<string, unknown> = {}): Config {
  return configSchema.parse({ ...MINIMAL_CONFIG_INPUT, ...patch });
}

/** Flux qui garde chaque ligne de journal JSON pour les assertions. */
export class LogCapture extends Writable {
  readonly lines: Array<Record<string, unknown>> = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) this.lines.push(JSON.parse(line) as Record<string, unknown>);
    }
    done();
  }

  text(): string {
    return JSON.stringify(this.lines);
  }
}

/** Objet Deps de test : horloge et aléa déterministes, journaux capturés. */
export function testDeps(config: Config = testConfig()): Deps & { logs: LogCapture } {
  const logs = new LogCapture();
  return {
    config,
    logger: createLogger(config.log, logs),
    clock: new FakeClock(new Date('2026-10-25T10:00:00Z')),
    random: new FakeRandom('tests'),
    logs,
  };
}
