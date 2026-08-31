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
 * A coordinate from whichever source has one, or null.
 *
 * `City` first: it has clean Float coordinates and a unique name/country pair.
 * The concert's own pair is a VarChar filled by whichever scraper got there
 * first, so it is the fallback and it is parsed rather than trusted.
 *
 * Resolved here rather than with a SQL `COALESCE(..., c.latitude::float)`,
 * because that cast takes the entire query down the first time a scraper writes
 * something that is not a number — turning one bad row into an empty overview
 * for every user. Here the same bad row becomes one show with an unknown
 * position, which the client's near-me rule already handles.
 *
 * Checked against null rather than for truthiness: zero is a real coordinate.
 */
function coord(cityValue, rawValue) {
  if (cityValue != null) {
    const n = typeof cityValue === 'string' ? parseFloat(cityValue) : cityValue;
    if (Number.isFinite(n)) return n;
  }
  if (rawValue != null) {
    const n = typeof rawValue === 'string' ? parseFloat(rawValue) : rawValue;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Group the per-city next-show rows by band, soonest first.
 *
 * A separate index from `byBandId` because this query returns one row per band
 * *and* city, so the one-row-per-band Map would keep only whichever city
 * happened to come last.
 *
 * An array rather than an object keyed by city, unlike the country version this
 * replaced. The client no longer looks a place up — it never asks "what is in
 * Denmark", it asks "what is nearest" — so it iterates, and an array is the
 * honest shape for something only ever iterated in date order.
 *
 * Built this way because the client owns the ranking of what counts as near
 * you: it is derived from your attendance and your home city, neither of which
 * this route knows. Sending your position up instead would make this per-user
 * and kill the cacheability of the most expensive route in the app.
 */
function byBandAndCity(rows) {
  const index = new Map();
  for (const row of rows ?? []) {
    if (!row?.city || !row?.country) continue;
    const id = String(row.band_id);
    const forBand = index.get(id) ?? [];
    // The id is what lets the client tell whether you are going to *this* show.
    // Matching on date and city instead would mark the wrong concert on any
    // night a band plays two venues in one city.
    forBand.push({
      id: row.concert_id ?? null,
      date: row.concert_date,
      soldOut: row.sold_out ?? false,
      country: row.country,
      city: row.city,
      lat: coord(row.city_lat, row.raw_lat),
      lng: coord(row.city_lng, row.raw_lng),
    });
    index.set(id, forBand);
  }

  // Sorted here rather than relied on from the query: DISTINCT ON forces an
  // ORDER BY that starts with the distinct key, so the rows arrive grouped by
  // city, not by date. Ties break on the concert id so the order cannot shuffle
  // between two responses.
  for (const shows of index.values()) {
    shows.sort((a, b) => new Date(a.date) - new Date(b.date) || (a.id ?? 0) - (b.id ?? 0));
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
function shapeBandOverview(bands, nextRows, lastRows, countryRows, perCityRows, images = {}) {
  const next = byBandId(nextRows);
  const last = byBandId(lastRows);
  const touring = byBandId(countryRows);
  const perCity = byBandAndCity(perCityRows);

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
      // The soonest show in each city the band plays, soonest first. Always an
      // array, so the client can iterate without a guard. Not a superset of
      // `nextConcertDate`: a show with no city is dropped here but is still a
      // real next show, which is why both fields survive.
      nextByCity: perCity.get(String(band.id)) ?? [],
      // Resolved from the band's Spotify id, not stored on it — see bandImages.
      // Explicitly null rather than absent for the same reason as the concert
      // fields above: the avatar reads one value and falls back to a monogram.
      image: (band.spotify_id && images[band.spotify_id]) || null,
      // The listen link, unlike the photo, needs nothing but the id — no Redis
      // round trip and no Spotify call. Sent even when `image` came back null, so
      // a band showing a monogram still links to its artist rather than falling
      // back to a name search that can land on the wrong band.
      spotifyId: band.spotify_id ?? null,
    };
  });
}

module.exports = { shapeBandOverview };
