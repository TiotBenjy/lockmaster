// Comparaisons de versions confrontées aux vrais outils, dans les conteneurs des distributions
// supportées (docs/09) : `dpkg --compare-versions`, `rpm.vercmp` (Lua de rpm), `apk version -t`.
// Trois contrôles par outil : les vecteurs de test/fixtures/upstream/ (vérifie leur transcription),
// des paires tirées au hasard avec une graine fixe sur un petit alphabet (beaucoup de préfixes
// communs), et la validité : une version que nous admettons doit l'être aussi par l'outil.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareApkVersion, isValidApkVersion } from '../../../src/formats/apk/version.js';
import { compareDebVersion, parseDebVersion } from '../../../src/formats/deb/version.js';
import { compareRpmEvr, rpmvercmp } from '../../../src/formats/rpm/version.js';
import { type Container, pinnedImage, startContainer } from '../support/containers.js';

const UPSTREAM = join(import.meta.dirname, '../../fixtures/upstream');
const SEED = 20261026;
const RANDOM_PAIRS = 2000;
const START_TIMEOUT = 300_000;

const lines = (file: string): string[][] =>
  readFileSync(join(UPSTREAM, file), 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim().split(/\s+/));

const pairs = (version: fc.Arbitrary<string>): [string, string][] =>
  fc.sample(fc.tuple(version, version), { numRuns: RANDOM_PAIRS, seed: SEED });

const sign = (value: number): number => Math.sign(value) || 0;
const output = (text: string): string[] => text.trim().split(/\s+/);

function isValidDeb(version: string): boolean {
  try {
    parseDebVersion(version);
    return true;
  } catch {
    return false;
  }
}

/** Paires dont notre résultat diffère de celui de l'outil (vide si tout concorde). */
function disagreements(
  input: readonly (readonly [string, string])[],
  tool: readonly string[],
  ours: (a: string, b: string) => string,
): string[] {
  return input.flatMap(([a, b], index) => {
    const expected = tool[index];
    const actual = ours(a, b);
    return actual === expected ? [] : [`${a} ${b} : outil ${expected}, Lockmaster ${actual}`];
  });
}

function withContainer(image: string): { get: () => Container } {
  let container: Container | undefined;
  beforeAll(async () => {
    container = await startContainer(pinnedImage(image));
  }, START_TIMEOUT);
  afterAll(async () => {
    await container?.stop();
  });
  return {
    get: () => {
      if (container === undefined) throw new Error('conteneur non démarré');
      return container;
    },
  };
}

const DPKG_COMPARE = `while read -r a b; do
  if ! dpkg --validate-version "$a" 2>/dev/null || ! dpkg --validate-version "$b" 2>/dev/null; then echo E; continue; fi
  if dpkg --compare-versions "$a" lt "$b"; then echo -1; elif dpkg --compare-versions "$a" eq "$b"; then echo 0; else echo 1; fi
done`;
const DPKG_VALID =
  'while IFS= read -r v; do if dpkg --validate-version "$v" 2>/dev/null; then echo ok; else echo bad; fi; done';

describe.each(['DEBIAN_12', 'DEBIAN_13'])('dpkg (%s)', (image) => {
  const container = withContainer(image);
  const compare = async (input: readonly (readonly [string, string])[]) =>
    output(await container.get().sh(DPKG_COMPARE, input.map((pair) => `${pair.join(' ')}\n`).join('')));

  it('confirme les 43 vecteurs de Dpkg_Version.t', async () => {
    const vectors = lines('dpkg/version.data');
    const tool = await compare(vectors.map(([a = '', b = '']) => [a, b] as const));
    expect(tool).toEqual(vectors.map(([, , expected]) => expected));
  });

  it(`ordonne comme dpkg ${RANDOM_PAIRS} paires tirées au hasard`, async () => {
    const version = fc.stringMatching(/^([01]:)?[01][0a.+~]{0,5}(-[0a.+~]{1,3})?$/);
    const input = pairs(version);
    const tool = await compare(input);
    expect(disagreements(input, tool, (a, b) => String(sign(compareDebVersion(a, b))))).toEqual([]);
  });

  it("n'admet aucune version que dpkg refuse", async () => {
    const candidates = fc.sample(fc.stringMatching(/^[0-9a-z.+~:-]{1,8}$/), { numRuns: RANDOM_PAIRS, seed: SEED });
    const tool = output(await container.get().sh(DPKG_VALID, candidates.map((v) => `${v}\n`).join('')));
    const accepted = candidates.filter((v, index) => isValidDeb(v) && tool[index] !== 'ok');
    expect(accepted).toEqual([]);
  });
});

const RPM_VERCMP = `rpm --eval '%{lua: local results = {}
for line in io.lines() do
  local a, b = line:match("^(%S+) (%S+)$")
  results[#results + 1] = rpm.vercmp(a, b)
end
print(table.concat(results, " "))}'`;

describe.each(['ROCKY_9', 'ROCKY_10'])('rpm (%s)', (image) => {
  const container = withContainer(image);
  const compare = async (input: readonly (readonly [string, string])[]) =>
    output(await container.get().sh(RPM_VERCMP, input.map((pair) => `${pair.join(' ')}\n`).join('')));

  it('confirme les 91 vecteurs de rpmvercmp.at', async () => {
    const vectors = lines('rpm/rpmvercmp.data');
    const tool = await compare(vectors.map(([a = '', b = '']) => [a, b] as const));
    expect(tool).toEqual(vectors.map(([, , expected]) => expected));
  });

  it(`compare comme rpmvercmp ${RANDOM_PAIRS} paires de versions`, async () => {
    const input = pairs(fc.stringMatching(/^[01a.~^_+]{1,6}$/));
    const tool = await compare(input);
    expect(disagreements(input, tool, (a, b) => String(rpmvercmp(a, b)))).toEqual([]);
  });

  it(`ordonne comme rpm ${RANDOM_PAIRS} paires epoch:version-release`, async () => {
    const input = pairs(fc.stringMatching(/^([01]:)?[01a.~^]{1,4}-[01a.~^]{1,3}$/));
    const tool = await compare(input);
    expect(disagreements(input, tool, (a, b) => String(sign(compareRpmEvr(a, b))))).toEqual([]);
  });
});

const APK_COMPARE = 'while read -r a b; do apk version -t "$a" "$b"; done';
const APK_VALID = 'while IFS= read -r v; do if [ -z "$(apk version -c "$v")" ]; then echo ok; else echo bad; fi; done';
const APK_SIGN: Readonly<Record<string, string>> = { '-1': '<', '0': '=', '1': '>' };

describe.each(['ALPINE_3_20', 'ALPINE_3_22'])('apk (%s)', (image) => {
  const container = withContainer(image);
  const compare = async (input: readonly (readonly [string, string])[]) =>
    output(await container.get().sh(APK_COMPARE, input.map((pair) => `${pair.join(' ')}\n`).join('')));

  it("confirme les 733 vecteurs de version.data d'apk-tools", async () => {
    const vectors = lines('apk-tools/version.data');
    const tool = await compare(vectors.map(([a = '', , b = '']) => [a, b] as const));
    expect(tool).toEqual(vectors.map(([, op]) => op));
  });

  it(`ordonne comme apk ${RANDOM_PAIRS} paires tirées au hasard`, async () => {
    const version = fc.stringMatching(/^[01](\.0?[0-9]){0,2}[ab]?(_(alpha|rc|p|git)[0-9]?){0,2}(-r[0-9])?$/);
    const input = pairs(version);
    const tool = await compare(input);
    expect(disagreements(input, tool, (a, b) => APK_SIGN[String(sign(compareApkVersion(a, b)))] ?? '?')).toEqual([]);
  });

  it("n'admet aucune version qu'apk refuse", async () => {
    const candidates = fc.sample(fc.stringMatching(/^[0-9a-z._-]{1,8}$/), { numRuns: RANDOM_PAIRS, seed: SEED });
    const tool = output(await container.get().sh(APK_VALID, candidates.map((v) => `${v}\n`).join('')));
    const accepted = candidates.filter((v, index) => isValidApkVersion(v) && tool[index] !== 'ok');
    expect(accepted).toEqual([]);
  });
});
