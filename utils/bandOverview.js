/**
 * Shaping for GET /upcoming/bands — the band overview table.
 *
 * The route used to run one `findFirst` per band inside a Promise.all to get the
 * next concert, which is 114 queries for the current band list and would have
 * been 228 once "last seen" was added. Both are now one `DISTINCT ON (band)`
 * query each, and this merges the four result sets.
 */

/**
 * Index concert rows by band id.
 *
 * The id is coerced to a string on both sides: an id that arrives from raw SQL
 * as `'1'` and one that arrives from Prisma as `1` have to land in the same
 * bucket, and a Map keyed on the raw value would silently miss every row and
 * leave the column empty for every band.
 */
function byBandId(rows) {
  const index = new Map();
  for (const row of rows ?? []) {
    index.set(String(row.band_id), row);
  }
  return index;
}

/**
 * Group the per-country next-show rows by band, keyed by country.
 *
 * A separate index from `byBandId` because this query returns one row per band
 * *and* country, so the one-row-per-band Map would keep only whichever country
 * happened to come last.
 *
 * Built for the merged touring/next-show column: the client owns the ranking of
 * which country counts as "near you" — it is derived from your attendance and
 * your home-country setting, neither of which this route knows — so the server
 * hands over every country's soonest show and lets the client pick.
 */
function byBandAndCountry(rows) {
  const index = new Map();
  for (const row of rows ?? []) {
    if (!row?.country) continue;
    const id = String(row.band_id);
    const forBand = index.get(id) ?? {};
    // The id is what lets the client tell whether you are going to *this* show.
    // Matching on date and country instead would mark the wrong concert on any
    // night a band plays two cities in one country.
    forBand[row.country] = {
      id: row.concert_id ?? null,
      date: row.concert_date,
      soldOut: row.sold_out ?? false,
    };
    index.set(id, forBand);
  }
  return index;
}

/**
 * Merge the band list with its next concert, last concert and touring rows.
 *
 * Driven by the band list, not by the concert rows: the two concert queries are
 * not scoped to whatever filtered this page, so a row for a band that is not
 * listed must not invent an entry for it.
 *
 * `images` maps Spotify artist id to a photo url, resolved by the route just
 * before this runs. It is a separate argument rather than a field on the band
 * because it comes from Redis and Spotify, not from the database.
 *
 * Every band gets all four concert fields explicitly, including the ones with no
 * concerts at all — the table renders a column apiece and `undefined` would
 * reach the row as a missing value rather than an empty one.
 */
function shapeBandOverview(bands, nextRows, lastRows, countryRows, perCountryRows, images = {}) {
  const next = byBandId(nextRows);
  const last = byBandId(lastRows);
  const touring = byBandId(countryRows);
  const perCountry = byBandAndCountry(perCountryRows);

  return (bands ?? []).map((band) => {
    const n = next.get(String(band.id));
    const l = last.get(String(band.id));

    return {
      id: band.id,
      name: band.name,
      songkick_url: band.songkick_url,
      bandsintown_url: band.bandsintown_url,
      concertCount: band._count?.concerts ?? 0,
      nextConcertDate: n?.concert_date ?? null,
      nextConcertCountry: n?.country ?? null,
      // Carried so the table can flag a sold-out next show. Note this is only
      // ever true once a scraper actually sets it — see the note on the route.
      nextConcertSoldOut: n?.sold_out ?? false,
      lastConcertDate: l?.concert_date ?? null,
      lastConcertCountry: l?.country ?? null,
      // Always an array, so the column can map over it without a guard. Nulls
      // are stripped: concerts carry a null country and array_agg keeps it,
      // which would render as a stray blank flag.
      touringCountries: (touring.get(String(band.id))?.countries ?? []).filter(Boolean),
      // The soonest show in each country the band plays. Always an object, so
      // the client can look a country up without a guard. Not a superset of
      // `nextConcertDate`: a concert with a null country is dropped here but is
      // still a real next show, which is why both fields survive.
      nextByCountry: perCountry.get(String(band.id)) ?? {},
      // Resolved from the band's Spotify id, not stored on it — see bandImages.
      // Explicitly null rather than absent for the same reason as the concert
      // fields above: the avatar reads one value and falls back to a monogram.
      image: (band.spotify_id && images[band.spotify_id]) || null,
    };
  });
}

module.exports = { shapeBandOverview };
