import { isIPv4, isIPv6 } from 'node:net';
import { LockmasterError } from '../domain/errors.js';

export interface ListenAddress {
  host: string;
  port: number;
}

// Adresses d'écoute : "hôte:port", "[ipv6]:port" ou ":port" (toutes les interfaces IPv4).
const ADDRESS = /^(?:\[([0-9A-Fa-f:.]+)\]|([^:[\]]*)):(0|[1-9][0-9]{0,4})$/;
const HOSTNAME_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function invalid(input: string, reason: string): LockmasterError {
  return new LockmasterError('CONFIG_INVALID_ADDRESS', `adresse d'écoute invalide « ${input} » : ${reason}`);
}

function isHostname(host: string): boolean {
  return host.length <= 253 && host.split('.').every((label) => HOSTNAME_LABEL.test(label));
}

/** Analyse une adresse d'écoute de la configuration. */
export function parseListenAddress(input: string): ListenAddress {
  const match = ADDRESS.exec(input);
  if (!match) throw invalid(input, 'attendu "hôte:port", "[ipv6]:port" ou ":port"');
  const [, ipv6, name, portText] = match;
  const port = Number(portText);
  if (port < 1 || port > 65_535) throw invalid(input, 'port hors de 1..65535');
  if (ipv6 !== undefined) {
    if (!isIPv6(ipv6)) throw invalid(input, 'adresse IPv6 incorrecte');
    return { host: ipv6, port };
  }
  const host = name ?? '';
  if (host === '') return { host: '0.0.0.0', port };
  if (/^[0-9.]+$/.test(host) ? !isIPv4(host) : !isHostname(host)) throw invalid(input, 'hôte incorrect');
  return { host, port };
}
