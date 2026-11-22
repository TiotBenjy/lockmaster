#!/usr/bin/env node
// Propose les exceptions au délai de 7 jours de pnpm (CONVENTIONS.md §Contenu externe) : pour chaque avis
// de `pnpm audit` de CVSS au moins 8,5 ou dont une CVE est dans le catalogue KEV, affiche la ligne de
// justification et l'entrée exacte à recopier dans pnpm-workspace.yaml. Le script ne modifie rien : le
// porteur relit l'avis et décide. Lecture seule sur le réseau (API des avis GitHub, catalogue KEV de la
// CISA, registre npm par `pnpm view`).
// Usage : node scripts/security-exception.mjs [--audit=f] [--advisories=f] [--kev=f] [--times=f] [--today=AAAA-MM-JJ]
//   --audit       sortie de `pnpm audit --json` (sinon lancée ici)
//   --advisories  {"GHSA-...": {"score": 9.8, "cves": ["CVE-..."]}} (sinon API GitHub)
//   --kev         ["CVE-...", ...] (sinon catalogue KEV)
//   --times       {"paquet@version": "date ISO de publication"} (sinon `pnpm view <paquet> time`)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const MIN_SCORE = 8.5;
const DELAY_DAYS = 7;
const DAY_MS = 86_400_000;
const root = join(import.meta.dirname, '..');
const { values } = parseArgs({
  options: {
    audit: { type: 'string' },
    advisories: { type: 'string' },
    kev: { type: 'string' },
    times: { type: 'string' },
    today: { type: 'string' },
  },
});
const today = values.today ?? new Date().toISOString().slice(0, 10);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function fail(message) {
  process.stderr.write(`security-exception : ${message}\n`);
  process.exit(1);
}

function runPnpm(args) {
  const result = spawnSync('pnpm', args, { cwd: root, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) fail(`pnpm ${args.join(' ')} : ${result.error.message}`);
  return result.stdout;
}

/** Avis de l'audit, au format npm (champ `advisories`) ; refuse toute autre forme. */
function auditAdvisories() {
  const audit = values.audit ? readJson(values.audit) : JSON.parse(runPnpm(['audit', '--json']));
  if (typeof audit !== 'object' || audit === null || typeof audit.advisories !== 'object') {
    fail('sortie de pnpm audit illisible (champ « advisories » attendu)');
  }
  return Object.values(audit.advisories).map((advisory) => {
    const { module_name: module, github_advisory_id: ghsa, patched_versions: patched } = advisory ?? {};
    if (![module, ghsa, patched].every((value) => typeof value === 'string'))
      fail('avis incomplet dans la sortie de pnpm audit');
    return { module, ghsa, patched };
  });
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'lockmaster-security-exception' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) fail(`${url} : HTTP ${response.status}`);
  return response.json();
}

/** Score CVSS (le plus élevé des versions publiées) et CVE d'un avis GitHub. */
async function advisoryDetails(ghsa, cache) {
  if (cache) return cache[ghsa] ?? fail(`${ghsa} absent de --advisories`);
  const data = await getJson(`https://api.github.com/advisories/${encodeURIComponent(ghsa)}`);
  const scores = [data.cvss_severities?.cvss_v3?.score, data.cvss_severities?.cvss_v4?.score, data.cvss?.score];
  const numeric = scores.filter((score) => typeof score === 'number' && score > 0);
  const cves = (data.identifiers ?? []).filter((id) => id.type === 'CVE').map((id) => id.value);
  return { score: numeric.length > 0 ? Math.max(...numeric) : null, cves };
}

async function kevCatalog() {
  if (values.kev) return new Set(readJson(values.kev));
  const url = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
  const data = await getJson(url);
  return new Set((data.vulnerabilities ?? []).map((entry) => entry.cveID));
}

function publication(module, version, cache) {
  if (cache) return cache[`${module}@${version}`] ?? fail(`${module}@${version} absent de --times`);
  const times = JSON.parse(runPnpm(['view', module, 'time', '--json']));
  return times[version] ?? fail(`date de publication de ${module}@${version} introuvable`);
}

/** Version exacte : seule une plage « >=X.Y.Z » donne une réponse sans ambiguïté. */
const exactVersion = (patched) => /^>=\s*(\d+\.\d+\.\d+)$/.exec(patched.trim())?.[1];

async function main() {
  const advisories = auditAdvisories();
  if (advisories.length === 0) {
    console.log('aucun avis de sécurité dans les dépendances : aucune exception à proposer');
    return;
  }
  const details = values.advisories ? readJson(values.advisories) : undefined;
  const times = values.times ? readJson(values.times) : undefined;
  const kev = await kevCatalog();
  const groups = new Map();
  for (const advisory of advisories) {
    const { score, cves } = await advisoryDetails(advisory.ghsa, details);
    const version = exactVersion(advisory.patched);
    if (!version) {
      console.log(
        `${advisory.module} (${advisory.ghsa}) : plage corrigée « ${advisory.patched} », version exacte à choisir`,
      );
      continue;
    }
    const spec = `${advisory.module}@${version}`;
    const group = groups.get(spec) ?? { module: advisory.module, version, ghsas: [], score: null, kev: false };
    group.ghsas.push(advisory.ghsa);
    if (score !== null) group.score = Math.max(group.score ?? 0, score);
    group.kev ||= cves.some((cve) => kev.has(cve));
    groups.set(spec, group);
  }
  const lines = [];
  for (const [spec, group] of groups) {
    const qualifies = (group.score ?? 0) >= MIN_SCORE || group.kev;
    if (!qualifies) {
      console.log(
        `${spec} : CVSS ${group.score ?? 'inconnu'}, hors KEV : sous le seuil de ${MIN_SCORE}, attendre le délai`,
      );
      continue;
    }
    const until = new Date(Date.parse(publication(group.module, group.version, times)) + DELAY_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    if (until <= today) {
      console.log(`${spec} : publiée il y a plus de ${DELAY_DAYS} jours, aucune exception nécessaire`);
      continue;
    }
    const reason = (group.score ?? 0) >= MIN_SCORE ? `CVSS ${group.score.toFixed(1)}` : 'KEV';
    lines.push({ spec, comment: `#  - ${spec} : ${group.ghsas.join(', ')} ; ${reason} ; retrait le ${until}` });
  }
  if (lines.length === 0) return;
  console.log('\nÀ valider par le porteur, puis à recopier dans pnpm-workspace.yaml :');
  for (const { comment } of lines) console.log(comment);
  console.log('minimumReleaseAgeExclude:');
  for (const { spec } of lines) console.log(`  - ${spec}`);
}

await main();
