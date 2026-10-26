// Écriture d'archives `ar` pour les fixtures (format commun des .deb, deb(5)) : en-tête de 60 octets
// par membre, données alignées sur 2 octets par un `\n`.

export interface ArEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

export interface ArHeaderFields {
  readonly name: string;
  readonly size: string;
  readonly magic?: string;
}

const pad = (value: string, width: number): string => value.padEnd(width, ' ').slice(0, width);

/** En-tête brut, sans validation : sert aussi à fabriquer des en-têtes malformés. */
export function arHeader(fields: ArHeaderFields): Uint8Array {
  const text =
    pad(fields.name, 16) + pad('0', 12) + pad('0', 6) + pad('0', 6) + pad('100644', 8) + pad(fields.size, 10);
  return Buffer.concat([Buffer.from(text, 'latin1'), Buffer.from(fields.magic ?? '`\n', 'latin1')]);
}

export interface BuildArOptions {
  /** Ajoute le `/` final des noms (variante GNU). */
  readonly gnuNames?: boolean;
  /** Omet l'octet d'alignement après le dernier membre de taille impaire. */
  readonly omitFinalPad?: boolean;
}

export function buildAr(entries: readonly ArEntry[], options: BuildArOptions = {}): Uint8Array {
  const parts: Uint8Array[] = [Buffer.from('!<arch>\n', 'latin1')];
  entries.forEach((entry, index) => {
    const name = options.gnuNames ? `${entry.name}/` : entry.name;
    parts.push(arHeader({ name, size: String(entry.data.length) }), entry.data);
    const last = index === entries.length - 1;
    if (entry.data.length % 2 === 1 && !(last && options.omitFinalPad)) parts.push(Buffer.from('\n'));
  });
  return Buffer.concat(parts);
}
