import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { LockmasterError } from '../domain/errors.js';
import { parseListenAddress } from './address.js';
import { parseDuration } from './duration.js';

// Types de champs réutilisés par le schéma (src/config/schema.ts).

/** Convertit une fonction d'analyse qui lève LockmasterError en transformation zod. */
function parsedBy<T>(parse: (input: string) => T) {
  return (value: string, ctx: z.RefinementCtx): T => {
    try {
      return parse(value);
    } catch (error) {
      if (!(error instanceof LockmasterError)) throw error;
      ctx.addIssue({ code: 'custom', message: error.message });
      return z.NEVER;
    }
  };
}

/** Durée "<entier><unité>", convertie en millisecondes. */
export const duration = (fallback: string) => z.string().default(fallback).transform(parsedBy(parseDuration));

/** Adresse d'écoute "hôte:port" ou ":port". */
export const listenAddress = (fallback: string) => z.string().default(fallback).transform(parsedBy(parseListenAddress));

/** Adresse d'écoute facultative : chaîne vide = désactivé. */
export const optionalListenAddress = () =>
  z
    .string()
    .default('')
    .transform(parsedBy((value) => (value === '' ? null : parseListenAddress(value))));

export const positiveInt = (fallback: number) => z.number().int().positive().default(fallback);
export const boundedInt = (min: number, max: number, fallback: number) =>
  z.number().int().min(min).max(max).default(fallback);

/** Chemin de fichier ou de dossier (absolu, ou relatif au fichier de configuration). Vide = non renseigné. */
export const path = (fallback = '') =>
  z
    .string()
    .default(fallback)
    .refine((value) => !value.includes('\0'), 'chemin avec octet nul')
    .refine((value) => value === '' || isAbsolute(value), 'chemin absolu attendu');

/** URL http(s) sans identifiants ni fragment. */
export const httpUrl = (options: { httpsOnly: boolean }) =>
  z.string().refine(
    (value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      const schemes = options.httpsOnly ? ['https:'] : ['https:', 'http:'];
      return schemes.includes(url.protocol) && url.username === '' && url.password === '' && url.hash === '';
    },
    options.httpsOnly ? 'URL https:// attendue (sans identifiants)' : 'URL http(s):// attendue (sans identifiants)',
  );

/** Adresse IP ou bloc CIDR. */
export const ipOrCidr = z.string().refine((value) => {
  const [ip, bits, ...rest] = value.split('/');
  if (rest.length > 0 || ip === undefined) return false;
  const family = isIP(ip);
  if (family === 0) return false;
  if (bits === undefined) return true;
  const max = family === 4 ? 32 : 128;
  return /^(0|[1-9][0-9]{0,2})$/.test(bits) && Number(bits) <= max;
}, 'adresse IP ou bloc CIDR attendu');

/** Empreinte OpenPGP (40 ou 64 caractères hexadécimaux). */
export const fingerprint = z
  .string()
  .regex(/^([0-9A-F]{40}|[0-9A-F]{64})$/, 'empreinte OpenPGP en hexadécimal majuscule');

export const ROLES = ['reader', 'uploader', 'maintainer', 'auditor', 'admin'] as const;
