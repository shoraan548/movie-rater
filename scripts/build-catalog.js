// Builds data/catalog.json from the official IMDb datasets (https://developer.imdb.com/non-commercial-datasets/).
//
//   node scripts/build-catalog.js [--min-votes 5000] [--refresh]
//
// Downloads (and caches in .cache/) title.ratings, title.basics and title.akas, keeps feature films with enough
// votes, picks the English release title and writes a compact JSON sorted by popularity.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'data', 'catalog.json');
const BASE = 'https://datasets.imdbws.com/';

const args = process.argv.slice(2);
const MIN_VOTES = +(args[args.indexOf('--min-votes') + 1] || 0) || 5000;
const REFRESH = args.includes('--refresh');

// Regions whose title is the English release title, best first. XWW = IMDb's "worldwide (English title)".
const EN_REGIONS = ['XWW', 'US', 'GB', 'CA', 'AU', 'IE', 'NZ'];
const GOOD_TYPES = new Set(['\\N', 'imdbDisplay']); // skip working/festival/dvd/tv/alternative titles for display

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function download(name) {
  const file = path.join(CACHE, name);
  if (!REFRESH && fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 7 * 864e5) return file;
  fs.mkdirSync(CACHE, { recursive: true });
  log('downloading', name);
  const r = await fetch(BASE + name);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  const total = +r.headers.get('content-length') || 0;
  let got = 0, lastPct = -1;
  const tmp = file + '.part';
  await pipeline(Readable.fromWeb(r.body).on('data', c => {
    got += c.length;
    const pct = total ? Math.floor(got / total * 100) : 0;
    if (pct % 10 === 0 && pct !== lastPct) { lastPct = pct; log(`  ${name} ${pct}%`); }
  }), fs.createWriteStream(tmp));
  fs.renameSync(tmp, file);
  return file;
}

async function eachRow(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let header = true;
  for await (const line of rl) {
    if (header) { header = false; continue; }
    fn(line.split('\t'));
  }
}

async function main() {
  const [ratingsFile, basicsFile, akasFile] = await Promise.all(
    ['title.ratings.tsv.gz', 'title.basics.tsv.gz', 'title.akas.tsv.gz'].map(download));

  log(`ratings: keeping titles with ${MIN_VOTES}+ votes`);
  const ratings = new Map();
  await eachRow(ratingsFile, ([id, rating, votes]) => {
    if (+votes >= MIN_VOTES) ratings.set(id, { rating: +rating, votes: +votes });
  });
  log(`  ${ratings.size} titles`);

  log('basics: keeping feature films');
  const films = new Map();
  await eachRow(basicsFile, ([id, type, primary, original, adult, year, , runtime, genres]) => {
    if (type !== 'movie' || adult === '1' || !ratings.has(id) || year === '\\N') return;
    films.set(id, {
      id, primary, original, year: +year,
      runtime: runtime === '\\N' ? 0 : +runtime,
      genres: genres === '\\N' ? [] : genres.split(','),
      ...ratings.get(id),
      en: {}, // region -> English title
    });
  });
  log(`  ${films.size} films`);

  log('akas: collecting English titles');
  await eachRow(akasFile, ([id, , title, region, language, types]) => {
    const f = films.get(id);
    // language matters: the US region also lists Spanish-language releases ("El club de la pelea")
    if (!f || !EN_REGIONS.includes(region) || !GOOD_TYPES.has(types) || (language !== '\\N' && language !== 'en')) return;
    if (!f.en[region] || types === 'imdbDisplay') f.en[region] = title;
  });

  const genres = [...new Set([...films.values()].flatMap(f => f.genres))].sort();
  const list = [...films.values()].sort((a, b) => b.votes - a.votes).map(f => {
    // IMDb's main title when it is also an English release title (avoids odd regional spellings), else the best region
    const enTitles = Object.values(f.en);
    const title = enTitles.includes(f.primary) ? f.primary : EN_REGIONS.map(r => f.en[r]).find(Boolean) || f.primary;
    // other names the same film may go by on Letterboxd — used only to match your Letterboxd export
    const alt = [...new Set([f.primary, f.original, ...Object.values(f.en)])].filter(t => t && t !== title);
    const row = [+f.id.slice(2), title, f.year, f.runtime, f.genres.map(g => genres.indexOf(g)), Math.round(f.rating * 10), f.votes];
    if (alt.length) row.push(alt);
    return row;
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const json = JSON.stringify({
    built: new Date().toISOString().slice(0, 10),
    minVotes: MIN_VOTES,
    fields: ['imdb', 'title', 'year', 'runtime', 'genres', 'rating10', 'votes', 'alt'],
    genres,
    films: list,
  });
  fs.writeFileSync(OUT, json);
  log(`wrote ${list.length} films → ${path.relative(ROOT, OUT)} (${(json.length / 1e6).toFixed(1)} MB, ${(zlib.gzipSync(json).length / 1e6).toFixed(1)} MB gzipped)`);
}

main().catch(e => { console.error(e); process.exit(1); });
