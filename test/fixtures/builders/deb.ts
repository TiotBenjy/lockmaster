// Générateur de paquets .deb pour les tests (deb(5)) : archive ar `debian-binary`, `control.tar.*`,
// `data.tar.*`, écrite sans dpkg-deb. Chaque partie peut être remplacée pour le corpus malformé.

import { type ArEntry, buildAr } from './ar.js';
import { compress, EXTENSIONS, type FixtureCompression } from './compress.js';
import { buildTar, type TarSpec } from './tar.js';

export const DEFAULT_CONTROL: Readonly<Record<string, string>> = {
  Package: 'hello',
  Source: 'hello-src (2.10-1)',
  Version: '2.10-3',
  Architecture: 'amd64',
  Maintainer: 'Equipe Test <test@example.org>',
  'Installed-Size': '42',
  'Pre-Depends': 'dpkg (>= 1.19)',
  Depends: 'libc6 (>= 2.34), libfoo | libbar (<< 2.0)',
  Provides: 'hello-virtual (= 2.10)',
  Conflicts: 'hello-old',
  Breaks: 'hello-plugin (<< 1.0)',
  Replaces: 'hello-old (<< 2.0)',
  Description: 'example package\n Long description.\n .\n Second paragraph.',
};

export interface DebSpec {
  /** Champs du contrôle (défaut DEFAULT_CONTROL) ou texte brut. */
  readonly control?: Readonly<Record<string, string>> | string;
  /** Scripts mainteneur et autres fichiers du contrôle : nom -> contenu. */
  readonly controlFiles?: Readonly<Record<string, string>>;
  /** Entrées tar du contrôle à la place de celles calculées. */
  readonly controlEntries?: readonly TarSpec[];
  readonly controlCompression?: FixtureCompression;
  readonly dataFiles?: readonly TarSpec[];
  readonly dataCompression?: FixtureCompression;
  readonly debianBinary?: string;
  /** Membres ar à la place de ceux calculés. */
  readonly members?: (parts: { binary: ArEntry; control: ArEntry; data: ArEntry }) => ArEntry[];
}

export function controlText(fields: Readonly<Record<string, string>>): string {
  return Object.entries(fields)
    .map(([name, value]) => `${name}: ${value}\n`)
    .join('');
}

export function buildDeb(spec: DebSpec = {}): Uint8Array {
  const control = typeof spec.control === 'string' ? spec.control : controlText(spec.control ?? DEFAULT_CONTROL);
  const entries: TarSpec[] = spec.controlEntries
    ? [...spec.controlEntries]
    : [
        { path: './', type: '5', mode: 0o755 },
        { path: './control', data: control },
        ...Object.entries(spec.controlFiles ?? {}).map(([name, data]) => ({ path: `./${name}`, data, mode: 0o755 })),
      ];
  const dataFiles = spec.dataFiles ?? [
    { path: './', type: '5', mode: 0o755 },
    { path: './usr/', type: '5', mode: 0o755 },
    { path: './usr/bin/', type: '5', mode: 0o755 },
    { path: './usr/bin/hello', data: '#!/bin/sh\necho bonjour\n', mode: 0o755 },
  ];
  const controlCompression = spec.controlCompression ?? 'gzip';
  const dataCompression = spec.dataCompression ?? 'xz';
  const parts = {
    binary: { name: 'debian-binary', data: Buffer.from(spec.debianBinary ?? '2.0\n') },
    control: {
      name: `control.tar${EXTENSIONS[controlCompression]}`,
      data: compress(buildTar(entries), controlCompression),
    },
    data: { name: `data.tar${EXTENSIONS[dataCompression]}`, data: compress(buildTar(dataFiles), dataCompression) },
  };
  return buildAr(spec.members ? spec.members(parts) : [parts.binary, parts.control, parts.data]);
}
