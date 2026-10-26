// Parseurs confrontés à de vrais paquets et aux vrais outils, dans les conteneurs des distributions
// supportées : paquets officiels téléchargés (apt-get download, dnf download, apk fetch) et paquets
// construits par dpkg-deb et rpmbuild avec chaque compression. Références : dpkg-deb (identité,
// control.tar et data.tar décompressés), rpm et rpm2cpio (identité, payload), createrepo_c
// (empreinte, taille, header-range de primary.xml), apk index (C:, identité, taille).

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apkFormat } from '../../../src/formats/apk/format.js';
import { DEFAULT_LIMITS } from '../../../src/formats/common/limits.js';
import { BufferSource } from '../../../src/formats/common/source.js';
import { debFormat } from '../../../src/formats/deb/format.js';
import type { PackageFormat } from '../../../src/formats/package-format.js';
import { rpmFormat } from '../../../src/formats/rpm/format.js';
import { type Container, pinnedImage, startContainer } from '../support/containers.js';

const SETUP_TIMEOUT = 540_000;
const options = { limits: DEFAULT_LIMITS };
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Lecture par notre parseur ; une erreur est préfixée du nom du fichier. */
async function parse(format: PackageFormat, file: string, bytes: Uint8Array) {
  try {
    return await format.parse(new BufferSource(bytes), options);
  } catch (error) {
    throw new Error(`${file} : ${(error as Error).message}`);
  }
}

async function innerStreams(format: PackageFormat, bytes: Uint8Array): Promise<Map<string, Buffer>> {
  const streams = new Map<string, Buffer>();
  for await (const stream of format.innerStreams(new BufferSource(bytes), options)) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.data) chunks.push(chunk);
    streams.set(stream.name, Buffer.concat(chunks));
  }
  return streams;
}

/** Lignes `champ|champ|...` produites par un script du conteneur. */
const rows = (text: string): string[][] =>
  text
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split('|'));

interface Fixture {
  container: Container;
  rows: string[][];
}

function withPackages(image: string, setup: string, describeScript: string): () => Fixture {
  let fixture: Fixture | undefined;
  beforeAll(async () => {
    const container = await startContainer(pinnedImage(image));
    fixture = { container, rows: [] };
    await container.sh(setup);
    fixture.rows = rows(await container.sh(describeScript));
  }, SETUP_TIMEOUT);
  afterAll(async () => {
    await fixture?.container.stop();
  });
  return () => {
    if (fixture === undefined) throw new Error('conteneur non préparé');
    return fixture;
  };
}

const DEB_SETUP = `set -e
export DEBIAN_FRONTEND=noninteractive
apt-get -qq update
mkdir -p /pkgs /build/demo/DEBIAN /build/demo/usr/bin
cd /pkgs
apt-get -qq download hello bash base-files tzdata 2>/dev/null
printf 'Package: demo\\nVersion: 1:2.0~rc1-3\\nArchitecture: all\\nMaintainer: Test <test@example.org>\\nDescription: demo\\n' > /build/demo/DEBIAN/control
printf '#!/bin/sh\\nexit 0\\n' > /build/demo/DEBIAN/postinst
printf '#!/bin/sh\\necho demo\\n' > /build/demo/usr/bin/demo
chmod 755 /build/demo/DEBIAN/postinst /build/demo/usr/bin/demo
for z in gzip xz zstd none; do dpkg-deb --root-owner-group -Z"$z" --build /build/demo "/pkgs/demo-$z.deb" >/dev/null; done`;

const DEB_DESCRIBE = `cd /pkgs
for f in *.deb; do
  printf '%s|%s|%s|%s|%s|%s|%s\\n' "$f" "$(dpkg-deb -f "$f" Package)" "$(dpkg-deb -f "$f" Version)" \\
    "$(dpkg-deb -f "$f" Architecture)" "$(sha256sum < "$f" | cut -d' ' -f1)" \\
    "$(dpkg-deb --ctrl-tarfile "$f" | sha256sum | cut -d' ' -f1)" "$(dpkg-deb --fsys-tarfile "$f" | sha256sum | cut -d' ' -f1)"
done`;

describe.each(['DEBIAN_12', 'DEBIAN_13'])('.deb réels (%s)', (image) => {
  const fixture = withPackages(image, DEB_SETUP, DEB_DESCRIBE);

  it('lit chaque paquet comme dpkg-deb, flux internes compris', async () => {
    const { container, rows: packages } = fixture();
    expect(packages.length).toBe(8);
    for (const [file = '', name, version, arch, digest, control, data] of packages) {
      const bytes = await container.read(`/pkgs/${file}`);
      const parsed = await parse(debFormat, file, bytes);
      expect({
        file,
        name: parsed.name,
        version: parsed.version,
        arch: parsed.arch,
        sha256: parsed.digests.sha256,
      }).toEqual({ file, name, version, arch, sha256: digest });
      const streams = await innerStreams(debFormat, bytes);
      expect([file, sha256(streams.get('control.tar') ?? Buffer.alloc(0))]).toEqual([file, control]);
      expect([file, sha256(streams.get('data.tar') ?? Buffer.alloc(0))]).toEqual([file, data]);
      if (file.startsWith('demo-')) expect(parsed.maintainerScripts).toContain('postinst');
    }
  });
});

const RPM_SPEC = `Name: demo
Version: 2.0~rc1
Release: 3
Epoch: 1
Summary: demo
License: MIT
BuildArch: noarch
%description
demo
%install
mkdir -p %{buildroot}/usr/bin
printf '#!/bin/sh\\necho demo\\n' > %{buildroot}/usr/bin/demo
chmod 755 %{buildroot}/usr/bin/demo
%post
exit 0
%files
/usr/bin/demo
`;

const RPM_SETUP = `set -e
dnf -y -q install dnf-plugins-core rpm-build createrepo_c >/dev/null
mkdir -p /pkgs /build
dnf -q download --destdir /pkgs bash setup tzdata libzstd >/dev/null
cat > /build/demo.spec <<'SPEC'
${RPM_SPEC}SPEC
for payload in w9.gzdio w6.xzdio w19.zstdio w9.bzdio w0.ufdio; do
  rpmbuild -bb --quiet --define "_topdir /build/$payload" --define "_binary_payload $payload" /build/demo.spec >/dev/null 2>&1
  cp /build/$payload/RPMS/noarch/*.rpm "/pkgs/demo-$payload.rpm"
done
createrepo_c -q --general-compress-type=gz /pkgs`;

const RPM_DESCRIBE = `cd /pkgs
for f in *.rpm; do
  printf '%s|%s|%s|%s|%s\\n' "$f" "$(rpm -qp --nosignature --qf '%{NAME}' "$f")" \\
    "$(rpm -qp --nosignature --qf '%|EPOCH?{%{EPOCH}:}:{}|%{VERSION}-%{RELEASE}' "$f")" \\
    "$(rpm -qp --nosignature --qf '%{ARCH}' "$f")" "$(rpm2cpio "$f" | sha256sum | cut -d' ' -f1)"
done`;

interface PrimaryEntry {
  checksum: string;
  size: number;
  start: number;
  end: number;
}

/** Entrées de primary.xml (createrepo_c) par nom de fichier. */
function readPrimary(xml: string): Map<string, PrimaryEntry> {
  const entries = new Map<string, PrimaryEntry>();
  for (const block of xml.split('<package ').slice(1)) {
    const href = /<location href="([^"]+)"/.exec(block)?.[1];
    const checksum = /<checksum type="sha256" pkgid="YES">([0-9a-f]{64})</.exec(block)?.[1];
    const size = /<size package="(\d+)"/.exec(block)?.[1];
    const range = /<rpm:header-range start="(\d+)" end="(\d+)"/.exec(block);
    if (href === undefined || checksum === undefined || size === undefined || range === null) {
      throw new Error('entrée de primary.xml incomplète');
    }
    entries.set(href, { checksum, size: Number(size), start: Number(range[1]), end: Number(range[2]) });
  }
  return entries;
}

describe.each(['ROCKY_9', 'ROCKY_10'])('.rpm réels (%s)', (image) => {
  const fixture = withPackages(image, RPM_SETUP, RPM_DESCRIBE);

  it('lit chaque paquet comme rpm, rpm2cpio et createrepo_c', async () => {
    const { container, rows: packages } = fixture();
    // dnf download peut tirer plus d'un paquet par nom (autre architecture) : au moins les 4 demandés.
    expect(packages.filter(([file = '']) => file.startsWith('demo-')).length).toBe(5);
    expect(packages.length).toBeGreaterThanOrEqual(9);
    const primary = readPrimary(await container.sh('zcat /pkgs/repodata/*-primary.xml.gz'));
    for (const [file = '', name, version, arch, payload] of packages) {
      const bytes = await container.read(`/pkgs/${file}`);
      const parsed = await parse(rpmFormat, file, bytes);
      const entry = primary.get(file);
      expect({ file, name: parsed.name, version: parsed.version, arch: parsed.arch }).toEqual({
        file,
        name,
        version,
        arch,
      });
      expect({
        file,
        checksum: parsed.digests.sha256,
        size: parsed.size,
        start: parsed.headerRange?.start,
        end: parsed.headerRange?.end,
      }).toEqual({ file, ...entry });
      const streams = await innerStreams(rpmFormat, bytes);
      expect([file, sha256(streams.get('payload.cpio') ?? Buffer.alloc(0))]).toEqual([file, payload]);
      if (file.startsWith('demo-')) expect(parsed.maintainerScripts.length).toBeGreaterThan(0);
    }
  });
});

const APK_SETUP = `set -e
apk update -q
mkdir -p /pkgs
apk fetch -q -o /pkgs busybox musl zlib bash ca-certificates
apk index -q --allow-untrusted -o /tmp/APKINDEX.tar.gz /pkgs/*.apk`;

const APK_DESCRIBE = `cd /pkgs
for f in *.apk; do printf '%s\\n' "$f"; done`;

/** Blocs de l'APKINDEX (apk index) par nom de paquet. */
function readApkIndex(text: string): Map<string, Record<string, string>> {
  const blocks = new Map<string, Record<string, string>>();
  for (const block of text.trim().split('\n\n')) {
    const fields = Object.fromEntries(block.split('\n').map((line) => [line.slice(0, 1), line.slice(2)]));
    blocks.set(fields['P'] ?? '', fields);
  }
  return blocks;
}

describe.each(['ALPINE_3_20', 'ALPINE_3_22'])('.apk réels (%s)', (image) => {
  const fixture = withPackages(image, APK_SETUP, APK_DESCRIBE);

  it('lit chaque paquet comme apk index, identifiant C: compris', async () => {
    const { container, rows: packages } = fixture();
    expect(packages.length).toBe(5);
    const index = readApkIndex(await container.sh('tar -xzOf /tmp/APKINDEX.tar.gz APKINDEX'));
    for (const [file = ''] of packages) {
      const bytes = await container.read(`/pkgs/${file}`);
      const parsed = await parse(apkFormat, file, bytes);
      const fields = index.get(parsed.name);
      expect({
        file,
        C: parsed.indexChecksum,
        P: parsed.name,
        V: parsed.version,
        A: parsed.arch,
        S: String(parsed.size),
      }).toEqual({
        file,
        C: fields?.['C'],
        P: fields?.['P'],
        V: fields?.['V'],
        A: fields?.['A'],
        S: fields?.['S'],
      });
      // Paquets d'Alpine signés par abuild-sign en `.SIGN.RSA.` (SHA-1) ; RSA256 pour les plus récents.
      expect(parsed.signatures).toHaveLength(1);
      expect(['RSA', 'RSA256']).toContain(parsed.signatures?.[0]?.algorithm);
      // Contrôle et données décompressés : la fin exacte de la décompression du fichier entier.
      const streams = await innerStreams(apkFormat, bytes);
      const ours = Buffer.concat([
        streams.get('control.tar') ?? Buffer.alloc(0),
        streams.get('data.tar') ?? Buffer.alloc(0),
      ]);
      const whole = gunzipSync(bytes);
      expect(whole.subarray(whole.length - ours.length).equals(ours)).toBe(true);
    }
  });
});
