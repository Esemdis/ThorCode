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
const { canonicalBandName } = require('./lineupNames');
const { sourceUrl, SOURCE_SITES } = require('./sourceUrl');

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

// MusicBrainz sheds load with a 503 whose body reads "The MusicBrainz web
// server is currently busy. Please try again later." Measured against the live
// API, roughly one request in three came back that way even at well under the
// documented 1 req/sec — so a single attempt loses the lookup, and the band
// keeps its missing urls until something re-queues it. Three attempts total,
// backing off, is enough to ride out a busy patch without becoming part of it.
const MB_RETRY_ATTEMPTS = 3;
const MB_RETRY_BASE_MS = 1500;

/**
 * Whether an error is MusicBrainz saying "not now" rather than "no".
 *
 * Only congestion is retried. A 404 or a 400 is an answer, and repeating it
 * just delays the failure by the whole backoff.
 */
function isBusyResponse(error) {
  const status = error?.response?.status;
  return status === 503 || status === 429;
}

/**
 * `client.get`, retried while MusicBrainz says it is busy.
 *
 * The backoff grows with each attempt and starts above MusicBrainz's own
 * 1 req/sec limit, so a retry never becomes the next request that gets shed.
 */
async function getWithRetry(client, url, config) {
  let lastError;
  for (let attempt = 0; attempt < MB_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await client.get(url, config);
    } catch (error) {
      if (!isBusyResponse(error)) throw error;
      lastError = error;
      if (attempt < MB_RETRY_ATTEMPTS - 1) await sleep(MB_RETRY_BASE_MS * (attempt + 1));
    }
  }
  throw lastError;
}

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
 * Returns the MBID it ended up using as a third element. That exists for the
 * band-create route: it needs an MBID to store, and resolving one itself meant
 * a second, unguarded copy of the search above — which then defeated the guard
 * by handing the result back in through `mbid`.
 *
 * @param {string} bandName
 * @param {string|null} [mbid]
 * @param {{ get: Function }} [client] - HTTP client; injectable so this can be
 *   tested without a network or a module mock (vitest externalises axios for
 *   this CommonJS module, so mocking it does not take).
 * @returns {Promise<[string|null, string|null, string|null]>} songkick url,
 *   bandsintown url, and the MBID used — null when none could be trusted.
 */
/**
 * A name as a Lucene phrase. A double quote in it ended the phrase early and a
 * backslash escaped whatever followed, so a band with either in its name was
 * searched for as something else.
 */
function lucenePhrase(text) {
  return `"${String(text).replace(/[\\"]/g, '\\$&')}"`;
}

async function findSourceUrls(bandName, mbid = null, client = axios) {
  let resolvedMbid = mbid;

  if (!resolvedMbid) {
    const searchRes = await getWithRetry(client, 'https://musicbrainz.org/ws/2/artist/', {
      params: { query: `artist:${lucenePhrase(bandName)}`, limit: 1, fmt: 'json' },
      headers: MB_HEADERS,
      timeout: 10000,
    });
    const candidate = searchRes.data?.artists?.[0] ?? null;
    if (!candidate) {
      console.log(`[findSourceUrls] MusicBrainz found no artist for "${bandName}"`);
      return [null, null, null];
    }
    if (!isConfidentNameMatch(bandName, candidate.name)) {
      console.log(
        `[findSourceUrls] MusicBrainz top match for "${bandName}" was "${candidate.name}" — too different to trust, treating as no match`,
      );
      return [null, null, null];
    }
    resolvedMbid = candidate.id;
    console.log(`[findSourceUrls] MusicBrainz resolved "${bandName}" → ${resolvedMbid} (${candidate.name})`);
    await sleep(SEARCH_SPACING_MS);
  }

  const relRes = await getWithRetry(client, `https://musicbrainz.org/ws/2/artist/${encodeURIComponent(resolvedMbid)}`, {
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
    // A rejected link leaves the slot empty, so a bad one listed first does
    // not shut out a real one after it (THO-976).
    if (!songkickUrl) songkickUrl = sourceUrl(url, SOURCE_SITES.songkick);
    if (!bandsintownUrl) bandsintownUrl = sourceUrl(url, SOURCE_SITES.bandsintown);
  }
  console.log(`[findSourceUrls] ${bandName} → songkick: ${songkickUrl}, bandsintown: ${bandsintownUrl}`);
  return [songkickUrl, bandsintownUrl, resolvedMbid];
}

/**
 * The MBID a client sent, if MusicBrainz agrees it belongs to `name`; else null.
 *
 * Band.MBID is unique and shared by every account, so an MBID taken from the
 * request on trust became the band's identity for everyone. quick-add stored
 * whatever pairing it was sent: one account could create "Not Gojira At All"
 * with Gojira's MBID, and the real Gojira was then refused as a duplicate (a
 * 409 naming the squatter) or resolved to the squatter (THO-758).
 *
 * Asks for that one artist by id, never a search, and accepts it only when
 * the id comes back unchanged — a merged id redirects to another artist, which
 * is not what the client claimed — and the canonical names are equal. Strict
 * equality rather than isConfidentNameMatch's 0.5 similarity: legitimate
 * callers send MusicBrainz-derived names, and "close enough" is exactly the
 * room a squatter needs.
 *
 * Fails closed on identity and open on availability: any error, a 404, or
 * MusicBrainz still busy after the retries gives null, and the caller stores
 * the band without an MBID rather than refusing it.
 *
 * @returns {Promise<string|null>}
 */
async function verifyClaimedMbid(name, mbid, client = axios) {
  try {
    const res = await getWithRetry(client, `https://musicbrainz.org/ws/2/artist/${encodeURIComponent(mbid)}`, {
      params: { fmt: 'json' },
      headers: MB_HEADERS,
      timeout: 10000,
    });
    const artist = res?.data;
    if (!artist || String(artist.id).toLowerCase() !== String(mbid).toLowerCase()) return null;
    const claimed = canonicalBandName(name);
    if (!claimed || canonicalBandName(artist.name) !== claimed) return null;
    return mbid;
  } catch (error) {
    console.error(`[verifyClaimedMbid] Could not verify ${mbid} for ${name}:`, error.message);
    return null;
  }
}

module.exports = {
  findSourceUrls,
  verifyClaimedMbid,
  lucenePhrase,
  isConfidentNameMatch,
  NAME_MATCH_THRESHOLD,
  MB_RETRY_ATTEMPTS,
  SEARCH_SPACING_MS,
  STALE_DAYS_DEFAULT,
  sleep,
};
