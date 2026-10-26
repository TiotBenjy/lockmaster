import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../../../../src/formats/common/limits.js';
import { BufferSource } from '../../../../src/formats/common/source.js';
import { rpmFormat } from '../../../../src/formats/rpm/format.js';
import { describePackageFormatContract } from '../../../contracts/package-format.contract.js';
import { buildRpm, type RpmSpec, TYPE } from '../../../fixtures/builders/rpm.js';

const SCRIPT = 'echo MARQUEUR-SEC01';

describePackageFormatContract(rpmFormat, () => ({
  plain: buildRpm(),
  expected: { name: 'hello', version: '2.10-3.el9', arch: 'x86_64' },
  // POSTINPROG en STRING : forme écrite par rpmbuild pour un interpréteur sans argument.
  withScript: buildRpm({
    tags: [
      { tag: 1024, type: TYPE.STRING, value: SCRIPT },
      { tag: 1086, type: TYPE.STRING, value: '/bin/sh' },
    ],
  }),
  script: '%post',
  marker: 'MARQUEUR-SEC01',
  versions: ['1.0~rc1-1', '1:0.1-1'],
}));

const options = { limits: DEFAULT_LIMITS };
const parse = (spec: RpmSpec = {}) => rpmFormat.parse(new BufferSource(buildRpm(spec)), options);

async function codeOf(bytes: Uint8Array, limits = DEFAULT_LIMITS): Promise<string> {
  try {
    await rpmFormat.parse(new BufferSource(bytes), { limits });
    return 'aucune erreur';
  } catch (error) {
    return (error as { code?: string }).code ?? `erreur sans code : ${String(error)}`;
  }
}

describe('parseRpm : métadonnées', () => {
  it("lit identité, source, relations, fichiers et étendue de l'en-tête", async () => {
    const bytes = buildRpm({ epoch: 1 });
    const parsed = await rpmFormat.parse(new BufferSource(bytes), options);
    expect(parsed).toMatchObject({
      name: 'hello',
      version: '1:2.10-3.el9',
      arch: 'x86_64',
      sourceName: 'hello',
      sourceVersion: '2.10-3.el9',
      maintainerScripts: [],
      files: ['/usr/bin/hello'],
    });
    expect(parsed.depends).toEqual([
      [{ name: 'libc.so.6()(64bit)', operator: 'ge', version: '2.34' }],
      [{ name: 'rpmlib(PayloadIsXz)', operator: 'le', version: '5.2-1' }],
      [{ name: '/bin/sh' }],
    ]);
    expect(parsed.provides).toEqual([
      { name: 'hello', operator: 'eq', version: '2.10-3.el9' },
      { name: 'hello(x86-64)', operator: 'eq', version: '2.10-3.el9' },
    ]);
    expect(parsed.conflicts).toEqual([{ name: 'hello-old', operator: 'lt', version: '2.0' }]);
    expect(parsed.replaces).toEqual([{ name: 'hello-legacy', operator: 'le', version: '1:1.0-1' }]);
    expect(parsed.control).toMatchObject({ Name: 'hello', Epoch: '1', Summary: 'Programme de démonstration' });
    const start = parsed.headerRange?.start ?? 0;
    expect(Buffer.from(bytes.subarray(start, start + 4)).toString('hex')).toBe('8eade801');
    expect(parsed.headerRange?.end).toBeGreaterThan(start);
  });

  it('signale chaque scriptlet, par son corps ou par son seul interpréteur', async () => {
    const tags = [
      { tag: 1151, type: TYPE.STRING, value: 'pretrans' },
      { tag: 1086, type: TYPE.STRING_ARRAY, value: ['/sbin/ldconfig'] },
      { tag: 1026, type: TYPE.STRING, value: 'postun' },
      { tag: 1065, type: TYPE.STRING_ARRAY, value: ['trigger'] },
      { tag: 5066, type: TYPE.STRING_ARRAY, value: ['filetrigger'] },
    ];
    expect((await parse({ tags })).maintainerScripts).toEqual([
      '%pretrans',
      '%post',
      '%postun',
      '%triggers',
      '%filetriggers',
    ]);
  });

  it.each(['gzip', 'xz', 'zstd', 'bzip2', 'none'] as const)('accepte un payload %s', async (compression) => {
    expect((await parse({ compression })).name).toBe('hello');
  });

  it('prend gzip quand PAYLOADCOMPRESSOR est absent (comportement de rpm)', async () => {
    expect((await parse({ compression: 'gzip', compressorName: null })).name).toBe('hello');
  });

  it.each<[string, RpmSpec]>([
    ['magie du lead', { lead: { magic: Uint8Array.of(0xed, 0xab, 0xee, 0xdc) } }],
    ['version de lead autre que 3', { lead: { major: 4 } }],
    ['paquet source', { lead: { type: 1 } }],
    ['type de signature autre que 5', { lead: { signatureType: 1 } }],
    ['SHA256HEADER absent', { signatureOmit: [273] }],
    ['SHA256HEADER faux', { signatureTags: [{ tag: 273, type: TYPE.STRING, value: '0'.repeat(64) }] }],
    ['SHA1HEADER faux', { signatureTags: [{ tag: 269, type: TYPE.STRING, value: '0'.repeat(40) }] }],
    ['taille déclarée fausse', { signatureTags: [{ tag: 1000, type: TYPE.INT32, value: 12 }] }],
    ['empreinte du payload fausse', { tags: [{ tag: 5092, type: TYPE.STRING_ARRAY, value: ['0'.repeat(64)] }] }],
    ["algorithme d'empreinte du payload inconnu", { tags: [{ tag: 5093, type: TYPE.INT32, value: 2 }] }],
    ['format de payload autre que cpio', { tags: [{ tag: 1124, type: TYPE.STRING, value: 'tar' }] }],
    ['NAME absent', { omit: [1000] }],
    ['VERSION absent', { omit: [1001] }],
    ['RELEASE absent', { omit: [1002] }],
    ['ARCH absent', { omit: [1022] }],
    ['SOURCERPM absent', { omit: [1044] }],
    ['SOURCERPM invalide', { tags: [{ tag: 1044, type: TYPE.STRING, value: 'hello.rpm' }] }],
    ['nom invalide', { name: 'hel lo' }],
    ['version avec tiret', { version: '2-10' }],
    ['release invalide', { release: '3/el9' }],
    ['architecture invalide', { arch: 'x86-64' }],
    ['epoch sur deux valeurs', { tags: [{ tag: 1003, type: TYPE.INT32, value: [1, 2] }] }],
    ['résumé sur deux lignes', { tags: [{ tag: 1004, type: TYPE.I18N, value: ['a\nb'] }] }],
    ['caractère de contrôle dans la description', { tags: [{ tag: 1005, type: TYPE.I18N, value: ['a\u0007b'] }] }],
    ['noms et drapeaux de dépendances inégaux', { tags: [{ tag: 1048, type: TYPE.INT32, value: [8] }] }],
    ['drapeaux de dépendance absents', { omit: [1048] }],
    ['sens de comparaison invalide', { tags: [{ tag: 1053, type: TYPE.INT32, value: [6] }] }],
    ['version de dépendance invalide', { tags: [{ tag: 1055, type: TYPE.STRING_ARRAY, value: ['2.0 beta'] }] }],
    ['version sans opérateur', { tags: [{ tag: 1053, type: TYPE.INT32, value: [0] }] }],
    ['opérateur sans version', { tags: [{ tag: 1055, type: TYPE.STRING_ARRAY, value: [''] }] }],
    ['nom de dépendance vide', { tags: [{ tag: 1054, type: TYPE.STRING_ARRAY, value: [''] }] }],
    ['indice de dossier hors limites', { tags: [{ tag: 1116, type: TYPE.INT32, value: [5] }] }],
    // Chaînes traduites : rpm choisit la traduction selon la locale du client (copyI18NEntry).
    ['NAME en I18NSTRING', { tags: [{ tag: 1000, type: TYPE.I18N, value: ['hello'] }] }],
    ['NAME en STRING_ARRAY', { tags: [{ tag: 1000, type: TYPE.STRING_ARRAY, value: ['hello'] }] }],
    ['ARCH en I18NSTRING', { tags: [{ tag: 1022, type: TYPE.I18N, value: ['x86_64'] }] }],
    ['POSTIN en I18NSTRING', { tags: [{ tag: 1024, type: TYPE.I18N, value: ['echo a'] }] }],
    ['REQUIRENAME en I18NSTRING', { tags: [{ tag: 1049, type: TYPE.I18N, value: ['a', 'b', 'c'] }] }],
    [
      'table de traductions à deux locales',
      {
        tags: [
          { tag: 100, type: TYPE.STRING_ARRAY, value: ['C', 'fr'] },
          { tag: 1004, type: TYPE.I18N, value: ['un', 'deux'] },
        ],
      },
    ],
    ['résumé traduit en deux chaînes', { tags: [{ tag: 1004, type: TYPE.I18N, value: ['un', 'deux'] }] }],
    // Caractères interdits en XML 1.0 (primary.xml, filelists.xml) et chemins non canoniques.
    ['nom de fichier avec un caractère de contrôle', { files: [{ name: './usr/bin/a\u0001b' }] }],
    ['description avec U+FFFF', { tags: [{ tag: 1005, type: TYPE.I18N, value: ['a\uffffb'] }] }],
    ['licence avec U+FFFE', { tags: [{ tag: 1014, type: TYPE.STRING, value: 'MIT\ufffe' }] }],
    ['nom de relation avec U+FFFF', { tags: [{ tag: 1054, type: TYPE.STRING_ARRAY, value: ['a\uffff'] }] }],
    ['dossier sans / initial', { tags: [{ tag: 1118, type: TYPE.STRING_ARRAY, value: ['usr/bin/'] }] }],
    ['dossier sans / final', { tags: [{ tag: 1118, type: TYPE.STRING_ARRAY, value: ['/usr/bin'] }] }],
    ['dossier avec //', { tags: [{ tag: 1118, type: TYPE.STRING_ARRAY, value: ['/etc//cron.d/'] }] }],
    ['dossier avec /./', { tags: [{ tag: 1118, type: TYPE.STRING_ARRAY, value: ['/etc/./cron.d/'] }] }],
    ['dossier avec /../', { tags: [{ tag: 1118, type: TYPE.STRING_ARRAY, value: ['/usr/../etc/'] }] }],
    ['nom de base avec /', { tags: [{ tag: 1117, type: TYPE.STRING_ARRAY, value: ['a/b'] }] }],
    ['nom de base ..', { tags: [{ tag: 1117, type: TYPE.STRING_ARRAY, value: ['..'] }] }],
    ['noms et indices de fichiers inégaux', { tags: [{ tag: 1116, type: TYPE.INT32, value: [0, 0] }] }],
  ])('refuse : %s (FORMAT_INVALID)', async (_label, spec) => {
    expect(await codeOf(buildRpm(spec))).toBe('FORMAT_INVALID');
  });

  it('accepte un paquet sans empreinte de payload ni obsolète (rpm < 4.14)', async () => {
    expect(await parse({ omit: [5092, 5093, 1090, 1114, 1115] })).toMatchObject({ name: 'hello', replaces: [] });
  });

  it.each<[string, RpmSpec]>([
    ['PAYLOADDIGEST sans son algorithme', { omit: [5093] }],
    ['SHA256HEADER au mauvais type', { signatureTags: [{ tag: 273, type: TYPE.INT32, value: 1 }] }],
    ['SHA256HEADER en tableau', { signatureTags: [{ tag: 273, type: TYPE.STRING_ARRAY, value: ['0'] }] }],
    ['SIZE au mauvais type', { signatureTags: [{ tag: 1000, type: TYPE.STRING, value: '12' }] }],
    ['LONGSIZE au-delà de 2^53', { signatureTags: [{ tag: 270, type: TYPE.INT64, value: 2n ** 60n }] }],
  ])('refuse : %s (FORMAT_INVALID)', async (_label, spec) => {
    expect(await codeOf(buildRpm(spec))).toBe('FORMAT_INVALID');
  });

  it('refuse un paquet sans payload (FORMAT_TRUNCATED)', async () => {
    const bytes = buildRpm();
    const parsed = await rpmFormat.parse(new BufferSource(bytes), options);
    expect(await codeOf(bytes.subarray(0, parsed.headerRange?.end ?? 0))).toBe('FORMAT_TRUNCATED');
  });

  it.each([
    ['lzma historique', 'lzma'],
    ['compresseur inconnu', 'lz4'],
  ])('refuse : %s (FORMAT_UNSUPPORTED_COMPRESSION)', async (_label, compressorName) => {
    expect(await codeOf(buildRpm({ compressorName }))).toBe('FORMAT_UNSUPPORTED_COMPRESSION');
  });

  it('refuse un en-tête modifié après signature et un payload modifié', async () => {
    const bytes = Buffer.from(buildRpm());
    const parsed = await rpmFormat.parse(new BufferSource(bytes), options);
    const start = parsed.headerRange?.start ?? 0;
    const tampered = Buffer.from(bytes);
    tampered[start + 200] = (tampered[start + 200] ?? 0) ^ 1;
    expect(await codeOf(tampered)).not.toBe('aucune erreur');
    const payload = Buffer.from(bytes);
    payload[payload.length - 3] = (payload[payload.length - 3] ?? 0) ^ 1;
    expect(await codeOf(payload)).toBe('FORMAT_INVALID');
  });

  it('vérifie LONGSIZE (64 bits) quand il remplace SIZE', async () => {
    const plain = buildRpm();
    const parsed = await rpmFormat.parse(new BufferSource(plain), options);
    const size = BigInt(plain.length - (parsed.headerRange?.start ?? 0));
    const spec: RpmSpec = { signatureOmit: [1000], signatureTags: [{ tag: 270, type: TYPE.INT64, value: size }] };
    expect((await parse(spec)).name).toBe('hello');
    expect(await codeOf(buildRpm({ ...spec, signatureTags: [{ tag: 270, type: TYPE.INT64, value: size + 1n }] }))).toBe(
      'FORMAT_INVALID',
    );
  });

  it('refuse plus de fichiers que rpmMaxFiles (FORMAT_LIMIT_EXCEEDED)', async () => {
    const files = [{ name: './a' }, { name: './b' }, { name: './c' }];
    expect(await codeOf(buildRpm({ files }), { ...DEFAULT_LIMITS, rpmMaxFiles: 2 })).toBe('FORMAT_LIMIT_EXCEEDED');
  });
});

describe('rpmInnerStreams (SEC-01)', () => {
  it("rend l'en-tête puis le payload cpio décompressé", async () => {
    for (const compression of ['gzip', 'xz', 'zstd', 'bzip2', 'none'] as const) {
      const rpm = buildRpm({ compression, tags: [{ tag: 1024, type: TYPE.STRING, value: SCRIPT }] });
      const seen: [string, string][] = [];
      for await (const stream of rpmFormat.innerStreams(new BufferSource(rpm), options)) {
        const parts: Uint8Array[] = [];
        for await (const chunk of stream.data) parts.push(chunk);
        seen.push([stream.name, Buffer.concat(parts).toString('latin1')]);
      }
      expect(seen.map(([name]) => name)).toEqual(['header', 'payload.cpio']);
      expect(seen[0]?.[1]).toContain('MARQUEUR-SEC01');
      expect(seen[1]?.[1]).toContain('echo bonjour');
      expect(seen[1]?.[1].startsWith('070701')).toBe(true);
    }
  });

  it('lit sans PAYLOADCOMPRESSOR un payload gzip ou non compressé, comme gzdio (lib/rpmte.c, zlib)', async () => {
    // rpmbuild n'écrit pas le tag pour `_binary_payload w0.ufdio` ; rpm lit alors en « gzip » par zlib,
    // qui laisse passer un flux sans la magie gzip.
    for (const compression of ['gzip', 'none'] as const) {
      const rpm = buildRpm({ compression, compressorName: null });
      const payload: Uint8Array[] = [];
      for await (const stream of rpmFormat.innerStreams(new BufferSource(rpm), options)) {
        if (stream.name !== 'payload.cpio') continue;
        for await (const chunk of stream.data) payload.push(chunk);
      }
      expect(Buffer.concat(payload).toString('latin1').startsWith('070701')).toBe(true);
    }
  });

  it('refuse un payload en clair derrière un PAYLOADCOMPRESSOR « gzip » explicite (FORMAT_CORRUPT_STREAM)', async () => {
    // rpm l'installerait (gzdio, mode transparent de zlib) : refus volontaire, fail-closed.
    const rpm = buildRpm({ compression: 'none', compressorName: 'gzip' });
    const iterate = async (): Promise<void> => {
      for await (const stream of rpmFormat.innerStreams(new BufferSource(rpm), options)) {
        for await (const _chunk of stream.data) {
          // consommation complète
        }
      }
    };
    await expect(iterate()).rejects.toMatchObject({ code: 'FORMAT_CORRUPT_STREAM' });
  });

  it('refuse un compresseur non pris en charge avant de rendre le payload', async () => {
    const iterate = async (): Promise<void> => {
      for await (const stream of rpmFormat.innerStreams(
        new BufferSource(buildRpm({ compressorName: 'lzma' })),
        options,
      )) {
        for await (const _chunk of stream.data) {
          // consommation complète
        }
      }
    };
    await expect(iterate()).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED_COMPRESSION' });
  });

  it("donne une étendue d'en-tête qui couvre exactement il et dl (header-range de primary.xml)", async () => {
    const bytes = Buffer.from(buildRpm());
    const parsed = await rpmFormat.parse(new BufferSource(bytes), options);
    const { start = 0, end = 0 } = parsed.headerRange ?? {};
    expect(end).toBe(start + 16 + 16 * bytes.readUInt32BE(start + 8) + bytes.readUInt32BE(start + 12));
  });
});
