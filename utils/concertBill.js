/**
 * Everyone who played a show, whether or not they have a Band row.
 *
 * A concert carries its lineup in two places. `ConcertBandReference` holds the
 * acts that matched a row in the Band table, which is how a photograph can be
 * tagged at all — ConcertMedia.band_id is a foreign key. `metadata` holds the
 * rest as plain strings: support acts nobody has ever wishlisted, which on a
 * festival is most of the lineup.
 *
 * The gig view is the only place in the app that says who played a night you
 * attended, so it needs both. An act with no row appears with `id: null` and
 * `linked: false` — it cannot be tagged until something creates its row, which
 * is a deliberate act with its own endpoint, because Band is one table shared
 * by every account.
 */

const { cleanLineupNames, canonicalBandName } = require('./lineupNames');

/**
 * @param {object} concert
 * @param {object[]} concert.bands - Acts with a Band row, already shaped.
 * @param {string|null} concert.metadata - The scraped lineup, JSON array of names.
 * @returns {object[]} The bill, linked acts first, in the order each source gives.
 */
function billForConcert({ bands = [], metadata }) {
  const bill = bands.map((band) => ({ ...band, linked: true }));

  // Matched on the canonical form rather than the literal string: the scraper
  // writes "Architects (UK)" where the band row says "Architects", and that
  // disambiguator is the single most common reason one act would otherwise be
  // listed twice — once as a pill you can tag, once as one you cannot.
  const seen = new Set(bands.map((b) => canonicalBandName(b.name)).filter(Boolean));

  let names = [];
  try {
    const parsed = JSON.parse(metadata || '[]');
    // Not an array means this column holds something other than a lineup,
    // which older rows do. Nothing to read, rather than something to guess at.
    if (Array.isArray(parsed)) names = cleanLineupNames(parsed);
  } catch {
    names = [];
  }

  for (const name of names) {
    const key = canonicalBandName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // No setlist, not even the band's most recent one: there is no band here
    // to have had one, and inheriting a neighbour's would be worse than none.
    bill.push({ id: null, name, setlist: null, recent_setlist: null, linked: false });
  }

  return bill;
}

module.exports = { billForConcert };
