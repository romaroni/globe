// Builds data/events.json: per-country annual event counts + population-weighted city lists.
// Sources are fetched from GitHub mirrors (see README for the full methodology).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');

const WDI = 'https://raw.githubusercontent.com/open-numbers/ddf--open_numbers--world_development_indicators/master';
const OWID_MARRIAGE = 'https://raw.githubusercontent.com/owid/owid-datasets/master/datasets/' +
  encodeURIComponent('Crude marriage rate (OWID based on UN, OECD, Eurostat and other sources)') + '/' +
  encodeURIComponent('Crude marriage rate (OWID based on UN, OECD, Eurostat and other sources)') + '.csv';

const MIN_YEAR = 1995;          // ignore anything older than this
const GRAD_COHORT_LAG = 22;     // graduates ≈ the birth cohort from ~22 years earlier…
const GRAD_FACTOR = 0.7;        // …× tertiary gross enrolment ratio × completion/duration factor
const CITY_MIN_POP = 15000;
const CITY_MAX_PER_COUNTRY = 250;

async function fetchText(url, name) {
  await fs.mkdir(CACHE, { recursive: true });
  const file = path.join(CACHE, name);
  try { return await fs.readFile(file, 'utf8'); } catch {}
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  const text = await res.text();
  await fs.writeFile(file, text);
  return text;
}

function parseCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur); rows.push(out);
  }
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// Returns Map<geo, Map<year, value>>
async function wdiSeries(code) {
  const name = `ddf--datapoints--${code}--by--geo--time.csv`;
  const rows = parseCSV(await fetchText(`${WDI}/datapoints/${name}`, name));
  const m = new Map();
  for (const r of rows) {
    const v = parseFloat(r[code]); if (!Number.isFinite(v)) continue;
    if (!m.has(r.geo)) m.set(r.geo, new Map());
    m.get(r.geo).set(+r.time, v);
  }
  return m;
}

function latest(series, geo, maxYear = 2024) {
  const s = series.get(geo); if (!s) return null;
  let best = null;
  for (const [y, v] of s) if (y >= MIN_YEAR && y <= maxYear && (!best || y > best.year)) best = { year: y, value: v };
  return best;
}

const main = async () => {
  const entities = parseCSV(await fetchText(`${WDI}/ddf--entities--geo--country.csv`, 'wdi-countries.csv'))
    .filter(e => e.iso3166_1_alpha2 && e.iso3166_1_numeric);

  const [pop, cbr, cdr, netm, bus, patR, patN, ter] = await Promise.all(
    ['sp_pop_totl', 'sp_dyn_cbrt_in', 'sp_dyn_cdrt_in', 'sm_pop_netm', 'ic_bus_nreg', 'ip_pat_resd', 'ip_pat_nres', 'se_ter_enrr']
      .map(wdiSeries));

  // Marriages (OWID, crude rate per 1,000) keyed by country name.
  const marriage = new Map();
  for (const r of parseCSV(await fetchText(OWID_MARRIAGE, 'owid-marriage.csv'))) {
    const y = +r.Year, v = parseFloat(r['Crude marriage rate (per 1,000 inhabitants)']);
    if (y < MIN_YEAR || !Number.isFinite(v)) continue;
    const prev = marriage.get(r.Entity);
    if (!prev || y > prev.year) marriage.set(r.Entity, { year: y, value: v });
  }
  const ALIAS = {
    'Czech Republic': 'CZ', 'Macedonia': 'MK', 'Swaziland': 'SZ', 'Russia': 'RU', 'South Korea': 'KR',
    'North Korea': 'KP', 'Iran': 'IR', 'Syria': 'SY', 'Vietnam': 'VN', 'Moldova': 'MD', 'Brunei': 'BN',
    'Cape Verde': 'CV', 'Hong Kong': 'HK', 'Macao': 'MO', 'Palestine': 'PS', 'Timor': 'TL', 'Kyrgyzstan': 'KG',
    'Slovakia': 'SK', 'Bahamas': 'BS', 'Egypt': 'EG', 'Venezuela': 'VE', 'Yemen': 'YE', 'Bolivia': 'BO',
    'United States': 'US', 'United Kingdom': 'GB', 'Laos': 'LA', 'Kosovo': 'XK', 'Saint Lucia': 'LC',
    'Saint Kitts and Nevis': 'KN', 'Saint Vincent and the Grenadines': 'VC', 'Faeroe Islands': 'FO', 'United Arab Emirates': 'AE',
  };
  const nameToIso = new Map(entities.map(e => [e.name.toLowerCase(), e.iso3166_1_alpha2.toUpperCase()]));
  const marriageByIso = new Map(), unmatched = [];
  for (const [name, rec] of marriage) {
    const iso = ALIAS[name] || nameToIso.get(name.toLowerCase());
    if (iso) marriageByIso.set(iso, rec); else unmatched.push(name);
  }
  if (unmatched.length) console.log('marriage rows without a country match (skipped):', unmatched.join(', '));

  const curated = parseCSV(await fs.readFile(path.join(ROOT, 'data/curated.csv'), 'utf8'));
  const bankruptcies = parseCSV(await fs.readFile(path.join(ROOT, 'data/bankruptcies.csv'), 'utf8'));

  // Cities (GeoNames cities1000 via all-the-cities), grouped by ISO2.
  const allCities = require('all-the-cities');
  const byCountry = new Map();
  for (const c of allCities) {
    if (!byCountry.has(c.country)) byCountry.set(c.country, []);
    byCountry.get(c.country).push(c);
  }

  const countries = [];
  for (const e of entities) {
    const geo = e.country, iso2 = e.iso3166_1_alpha2.toUpperCase();
    const p = latest(pop, geo); if (!p) continue;
    const P = p.value;
    const rates = {}, meta = {};
    const put = (type, perYear, year, source) => {
      if (perYear > 0 && Number.isFinite(perYear)) { rates[type] = Math.round(perYear); meta[type] = { year, source }; }
    };

    const b = latest(cbr, geo); if (b) put('birth', b.value / 1000 * P, b.year, 'World Bank WDI SP.DYN.CBRT.IN');
    const d = latest(cdr, geo); if (d) put('death', d.value / 1000 * P, d.year, 'World Bank WDI SP.DYN.CDRT.IN');
    const m = marriageByIso.get(iso2);
    if (m) put('marriage', m.value / 1000 * P, m.year, 'OWID crude marriage rate (UN, OECD, Eurostat)');
    const nb = latest(bus, geo); if (nb) put('business', nb.value, nb.year, 'World Bank WDI IC.BUS.NREG');
    const pr = latest(patR, geo), pn = latest(patN, geo);
    if (pr || pn) put('patent', (pr?.value || 0) + (pn?.value || 0), Math.max(pr?.year || 0, pn?.year || 0), 'World Bank WDI IP.PAT.RESD + IP.PAT.NRES');
    const g = latest(ter, geo);
    if (g) {
      const cy = g.year - GRAD_COHORT_LAG;
      const cohortCbr = cbr.get(geo)?.get(cy), cohortPop = pop.get(geo)?.get(cy);
      if (cohortCbr && cohortPop) {
        const cohort = cohortCbr / 1000 * cohortPop;
        put('graduation', cohort * Math.min(g.value, 100) / 100 * GRAD_FACTOR, g.year, 'Modeled: birth cohort × WDI SE.TER.ENRR');
      }
    }
    const nm = latest(netm, geo);
    let migration = null;
    if (nm && nm.value !== 0) { migration = Math.round(nm.value); meta.migration = { year: nm.year, source: 'World Bank WDI SM.POP.NETM (UN WPP)' }; }

    for (const c of curated.filter(c => c.iso2 === iso2)) {
      put(c.type, parseFloat(c.rate_per_1000) / 1000 * P, +c.year, c.source);
    }

    for (const b of bankruptcies.filter(b => b.iso2 === iso2)) put('bankruptcy', +b.count, +b.year, b.source);

    let cities = (byCountry.get(iso2) || []).sort((a, b) => b.population - a.population);
    const big = cities.filter(c => c.population >= CITY_MIN_POP);
    cities = (big.length >= 3 ? big : cities.slice(0, 5)).slice(0, CITY_MAX_PER_COUNTRY);
    if (!cities.length) continue;

    countries.push({
      iso2, num: e.iso3166_1_numeric.padStart(3, '0'), name: e.name, population: Math.round(P),
      rates, migration, meta,
      cities: cities.map(c => [c.name, +c.loc.coordinates[0].toFixed(3), +c.loc.coordinates[1].toFixed(3), c.population]),
    });
  }

  const totals = {};
  for (const c of countries) for (const [t, v] of Object.entries(c.rates)) totals[t] = (totals[t] || 0) + v;
  totals.migration = countries.reduce((s, c) => s + Math.max(0, c.migration || 0), 0);
  const coverage = {};
  for (const c of countries) for (const t of Object.keys(c.rates)) coverage[t] = (coverage[t] || 0) + 1;
  coverage.migration = countries.filter(c => c.migration).length;

  const out = { generated: new Date().toISOString().slice(0, 10), totals, coverage, countries };
  await fs.writeFile(path.join(ROOT, 'data/events.json'), JSON.stringify(out));

  // Vendor the browser libraries and the base map so the page has no CDN dependency.
  const nm_ = p => path.join(ROOT, 'node_modules', p);
  await fs.copyFile(nm_('d3/dist/d3.min.js'), path.join(ROOT, 'vendor/d3.min.js'));
  await fs.copyFile(nm_('topojson-client/dist/topojson-client.min.js'), path.join(ROOT, 'vendor/topojson-client.min.js'));
  await fs.copyFile(nm_('motion/dist/motion.js'), path.join(ROOT, 'vendor/motion.js'));
  await fs.copyFile(nm_('world-atlas/countries-110m.json'), path.join(ROOT, 'data/countries-110m.json'));

  console.log(`countries: ${countries.length}`);
  for (const t of Object.keys(totals)) {
    const perYear = totals[t];
    console.log(`${t.padEnd(10)} ${String(coverage[t]).padStart(4)} countries  ${(perYear / 1e6).toFixed(2).padStart(7)}M/yr  ${(perYear / 31557600).toFixed(2)}/s`);
  }
};

main().catch(err => { console.error(err); process.exit(1); });
