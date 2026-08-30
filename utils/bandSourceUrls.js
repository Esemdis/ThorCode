/**
 * Finding a band's Songkick and Bandsintown pages via MusicBrainz.
 *
 * Split out of the bands route so the cron backfill (see
 * `bandSourceUrlBackfill.js`) and the admin refresh route run exactly the
 * same lookup. Deliberately has no `prisma` import — pulling in the client
 * requires a real `DATABASE_URL` at module load, which would make this file
 * (and its "is this really the band we asked about" check) untestable
 * without a database.
 */

const axios = require('axios');
const { stringSimilarity } = require('./concertDedup');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MB_HEADERS = {
  'User-Agent': `${process.env.APP_NAME || 'ConcertMap'}/1.0 (${process.env.APP_CONTACT || 'contact@example.com'})`,
  'Accept': 'application/json',
};

// Spaced rather than parallel: MusicBrainz's own limit is 1 req/sec, and nothing
// is waiting on the result of a backfill sweep.
const SEARCH_SPACING_MS = 1100;
const STALE_DAYS_DEFAULT = 14;

// Below this, MusicBrainz's top search result is treated as a different band,
// not this one. A plain `query: artist:"X", limit: 1` search always returns
// SOMETHING — for an unlisted or misspelled band, the closest name in MB's
// index can be an unrelated, much bigger act that only shares a word, and
// trusting its id would attach that act's Songkick/Bandsintown links to the
// wrong local band. 0.5 is loose on purpose: MB names carry legitimate noise
// (casing, "The", a disambiguation suffix) that stringSimilarity already
// tolerates reasonably well; this is only meant to catch real mismatches.
const NAME_MATCH_THRESHOLD = 0.5;

/**
 * Whether a MusicBrainz search result actually looks like the band asked
 * about, rather than just the closest thing MB's index had.
 *
 * @param {string} bandName
 * @param {string} candidateName
 * @returns {boolean}
 */
function isConfidentNameMatch(bandName, candidateName) {
  if (!candidateName) return false;
  return stringSimilarity(bandName, candidateName) >= NAME_MATCH_THRESHOLD;
}

/**
 * Fetch Songkick + Bandsintown URLs from MusicBrainz URL relationships.
 *
 * Uses the MBID directly if known; otherwise searches by artist name first,
 * then checks the top result's name against `bandName` (see
 * `isConfidentNameMatch`) before trusting its id.
 *
 * Throws when MusicBrainz itself could not be reached or errored, rather than
 * resolving to `[null, null]` — a caller that wants to know "checked, nothing
 * found" from "never got an answer" (e.g. to decide whether to stamp
 * `source_urls_checked_at`) needs those to be distinguishable.
 *
 * @param {string} bandName
 * @param {string|null} [mbid]
 * @param {{ get: Function }} [client] - HTTP client; injectable so this can be
 *   tested without a network or a module mock (vitest externalises axios for
 *   this CommonJS module, so mocking it does not take).
 * @returns {Promise<[string|null, string|null]>}
 */
async function findSourceUrls(bandName, mbid = null, client = axios) {
  let resolvedMbid = mbid;

  if (!resolvedMbid) {
    const searchRes = await client.get('https://musicbrainz.org/ws/2/artist/', {
      params: { query: `artist:"${bandName}"`, limit: 1, fmt: 'json' },
      headers: MB_HEADERS,
      timeout: 10000,
    });
    const candidate = searchRes.data?.artists?.[0] ?? null;
    if (!candidate) {
      console.log(`[findSourceUrls] MusicBrainz found no artist for "${bandName}"`);
      return [null, null];
    }
    if (!isConfidentNameMatch(bandName, candidate.name)) {
      console.log(
        `[findSourceUrls] MusicBrainz top match for "${bandName}" was "${candidate.name}" — too different to trust, treating as no match`,
      );
      return [null, null];
    }
    resolvedMbid = candidate.id;
    console.log(`[findSourceUrls] MusicBrainz resolved "${bandName}" → ${resolvedMbid} (${candidate.name})`);
    await sleep(SEARCH_SPACING_MS);
  }

  const relRes = await client.get(`https://musicbrainz.org/ws/2/artist/${resolvedMbid}`, {
    params: { inc: 'url-rels', fmt: 'json' },
    headers: MB_HEADERS,
    timeout: 10000,
  });
  const relations = relRes.data?.relations ?? [];
  let songkickUrl = null;
  let bandsintownUrl = null;
  for (const rel of relations) {
    const url = rel.url?.resource;
    if (!url) continue;
    if (!songkickUrl && url.includes('songkick.com')) songkickUrl = url.split('?')[0].replace(/\/$/, '');
    if (!bandsintownUrl && url.includes('bandsintown.com')) bandsintownUrl = url.split('?')[0].replace(/\/$/, '');
  }
  console.log(`[findSourceUrls] ${bandName} → songkick: ${songkickUrl}, bandsintown: ${bandsintownUrl}`);
  return [songkickUrl, bandsintownUrl];
}

module.exports = {
  findSourceUrls,
  isConfidentNameMatch,
  NAME_MATCH_THRESHOLD,
  SEARCH_SPACING_MS,
  STALE_DAYS_DEFAULT,
  sleep,
};
