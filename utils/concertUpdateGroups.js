/**
 * Grouping for the Updates panel's recent-concerts feed.
 *
 * The feed used to be a flat list of the newest future concerts, which meant a
 * band announcing a thirty-date tour filled every row and every other band's
 * news vanished. Collapsing each band's concerts into one group keeps a tour to
 * a single entry, so the panel stays a list of *bands with news* rather than a
 * list of dates.
 *
 * A group is keyed by the whole set of wishlist bands on a bill, not by one
 * band. A festival with three of yours on it used to become three groups, each
 * repeating the same show; now it is one group headed by all three. A
 * co-headline tour stacks the same way, and a band's own shows stay under it
 * alone.
 */

const DEFAULT_MAX_GROUPS = 30;
const DEFAULT_MAX_CONCERTS_PER_GROUP = 50;

/**
 * Collapse concerts into one group per set of wishlist bands on the bill.
 *
 * @param {Array} concerts concerts carrying `participating_bands` (only the
 *   wishlist's own), newest-inserted first
 * @param {{maxGroups?: number, maxConcertsPerGroup?: number}} [options]
 * @returns {Array} groups, most recently announced first
 */
function groupConcertsByBand(concerts, options = {}) {
  const {
    maxGroups = DEFAULT_MAX_GROUPS,
    maxConcertsPerGroup = DEFAULT_MAX_CONCERTS_PER_GROUP,
  } = options;

  const byBill = new Map();

  for (const concert of concerts ?? []) {
    const bands = [...new Map((concert.participating_bands ?? []).map((b) => [b.id, b])).values()];
    if (bands.length === 0) continue;
    const key = billKey(bands);
    let group = byBill.get(key);
    if (!group) {
      group = { key, bands, concerts: [] };
      byBill.set(key, group);
    }
    group.concerts.push(concert);
  }

  return [...byBill.values()]
    // Order by the newest announcement, never by group size: a band with one
    // brand-new show should outrank a tour that was inserted last week.
    .map((group) => summarize(group, maxConcertsPerGroup))
    .sort((a, b) => b.newest_created_at - a.newest_created_at)
    .slice(0, maxGroups);
}

function summarize(group, maxConcertsPerGroup) {
  const byDate = [...group.concerts].sort(
    (a, b) => new Date(a.concert_date) - new Date(b.concert_date),
  );

  return {
    key: group.key,
    bands: group.bands,
    // The first of them alone, for a client that predates `bands`: it heads
    // the row with this one and still shows the rest as pills on the show.
    band: group.bands[0],
    // The true total, even when the list below is capped, so the row can say
    // "24 shows" while sending far fewer.
    count: byDate.length,
    first_date: byDate[0]?.concert_date ?? null,
    last_date: byDate[byDate.length - 1]?.concert_date ?? null,
    countries: countriesByFrequency(byDate),
    newest_created_at: group.concerts.reduce(
      (newest, c) => (new Date(c.created_at) > newest ? new Date(c.created_at) : newest),
      new Date(0),
    ),
    concerts: byDate.slice(0, maxConcertsPerGroup),
  };
}

// The same bands in any order are the same bill. Ids are compared as strings
// because they have arrived as both.
function billKey(bands) {
  return bands.map((b) => String(b.id)).sort().join('+');
}

// Most-visited country first, so a tour reads as "SE · NO · DK" with its centre
// of gravity at the front rather than in whatever order the rows arrived.
function countriesByFrequency(concerts) {
  const counts = new Map();
  for (const { country } of concerts) {
    if (!country) continue;
    counts.set(country, (counts.get(country) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code);
}

module.exports = { groupConcertsByBand };
