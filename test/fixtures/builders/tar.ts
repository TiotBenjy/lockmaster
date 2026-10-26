// Écriture d'archives tar pour les fixtures (POSIX.1-2001 ustar et pax, variante GNU) : blocs de
// 512 octets, en-tête avec somme de contrôle octale, données complétées par des zéros. Les options
// de corruption servent au corpus malformé (docs/10 §Fixtures).

const BLOCK = 512;

export interface TarSpec {
  readonly path: string;
  readonly data?: Uint8Array | string;
  /** Type ustar : '0' fichier, '1' lien dur, '2' lien symbolique, '5' dossier, 'x' pax... */
  readonly type?: string;
  readonly mode?: number;
  readonly linkTarget?: string;
  /** 'ustar' (défaut) : magie POSIX `ustar\0` + `00` ; 'gnu' : `ustar ` + ` \0`. */
  readonly format?: 'ustar' | 'gnu';
  /** Préfixe ustar (champ de 155 octets) écrit tel quel. */
  readonly prefix?: string;
  /** Taille écrite dans l'en-tête à la place de la vraie (corpus malformé). */
  readonly declaredSize?: string;
  readonly corruptChecksum?: boolean;
}

const bytesOf = (data: Uint8Array | string | undefined): Uint8Array =>
  typeof data === 'string' ? Buffer.from(data, 'utf8') : (data ?? new Uint8Array(0));

function writeField(header: Buffer, offset: number, width: number, value: string): void {
  header.write(value.slice(0, width), offset, width, 'utf8');
}

const octal = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, '0')}\0`;

export function tarHeader(spec: TarSpec, size: number): Uint8Array {
  const header = Buffer.alloc(BLOCK);
  writeField(header, 0, 100, spec.path);
  writeField(header, 100, 8, octal(spec.mode ?? 0o644, 8));
  writeField(header, 108, 8, octal(0, 8));
  writeField(header, 116, 8, octal(0, 8));
  writeField(header, 124, 12, spec.declaredSize ?? octal(size, 12));
  writeField(header, 136, 12, octal(0, 12));
  writeField(header, 156, 1, spec.type ?? '0');
  writeField(header, 157, 100, spec.linkTarget ?? '');
  writeField(header, 257, 8, spec.format === 'gnu' ? 'ustar  \0' : 'ustar\u000000');
  writeField(header, 265, 32, 'root');
  writeField(header, 297, 32, 'root');
  writeField(header, 345, 155, spec.prefix ?? '');
  header.fill(0x20, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0) + (spec.corruptChecksum ? 1 : 0);
  writeField(header, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

/** Enregistrements pax `"<longueur> <clé>=<valeur>\n"`, la longueur se comptant elle-même. */
export function paxRecords(records: Readonly<Record<string, string>>): string {
  return Object.entries(records)
    .map(([key, value]) => {
      const body = ` ${key}=${value}\n`;
      let length = Buffer.byteLength(body) + 1;
      while (String(length).length + Buffer.byteLength(body) !== length) length += 1;
      return `${length}${body}`;
    })
    .join('');
}

export function tarEntry(spec: TarSpec): Uint8Array {
  const data = bytesOf(spec.data);
  const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
  return Buffer.concat([tarHeader(spec, data.length), data, Buffer.alloc(padding)]);
}

export interface BuildTarOptions {
  /** Écrit les deux blocs nuls de fin (défaut : oui ; les contrôles apk n'en ont pas). */
  readonly endMarker?: boolean;
}

export function buildTar(specs: readonly TarSpec[], options: BuildTarOptions = {}): Uint8Array {
  const parts = specs.map(tarEntry);
  if (options.endMarker ?? true) parts.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(parts);
}
