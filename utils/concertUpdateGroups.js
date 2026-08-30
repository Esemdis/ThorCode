/**
 * Grouping for the Updates panel's recent-concerts feed.
 *
 * The feed used to be a flat list of the newest future concerts, which meant a
 * band announcing a thirty-date tour filled every row and every other band's
 * news vanished. Collapsing each band's concerts into one group keeps a tour to
 * a single entry, so the panel stays a list of *bands with news* rather than a
 * list of dates.
 */

const DEFAULT_MAX_GROUPS = 30;
const DEFAULT_MAX_CONCERTS_PER_GROUP = 50;

/**
 * Collapse concerts into one group per wishlist band.
 *
 * @param {Array} concerts concerts carrying `participating_bands`, newest-inserted first
 * @param {{maxGroups?: number, maxConcertsPerGroup?: number}} [options]
 * @returns {Array} groups, most recently announced first
 */
function groupConcertsByBand(concerts, options = {}) {
  const {
    maxGroups = DEFAULT_MAX_GROUPS,
    maxConcertsPerGroup = DEFAULT_MAX_CONCERTS_PER_GROUP,
  } = options;

  const byBand = new Map();

  for (const concert of concerts ?? []) {
    // A concert with several wishlist bands on it — a festival, usually — is
    // added to each of their groups. It is real news for every one of them, and
    // choosing a single owner would drop it from the others' updates entirely.
    for (const band of concert.participating_bands ?? []) {
      let group = byBand.get(band.id);
      if (!group) {
        group = { band, concerts: [] };
        byBand.set(band.id, group);
      }
      group.concerts.push(concert);
    }
  }

  return [...byBand.values()]
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
    band: group.band,
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
