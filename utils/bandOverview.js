/**
 * Shaping for GET /upcoming/bands — the band overview table.
 *
 * The route used to run one `findFirst` per band inside a Promise.all to get the
 * next concert, which is 114 queries for the current band list and would have
 * been 228 once "last seen" was added. Both are now one `DISTINCT ON (band)`
 * query each, and this merges the three result sets.
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
 * Merge the band list with its next concert, last concert and touring rows.
 *
 * Driven by the band list, not by the concert rows: the two concert queries are
 * not scoped to whatever filtered this page, so a row for a band that is not
 * listed must not invent an entry for it.
 *
 * Every band gets all four concert fields explicitly, including the ones with no
 * concerts at all — the table renders a column apiece and `undefined` would
 * reach the row as a missing value rather than an empty one.
 */
function shapeBandOverview(bands, nextRows, lastRows, countryRows) {
  const next = byBandId(nextRows);
  const last = byBandId(lastRows);
  const touring = byBandId(countryRows);

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
    };
  });
}

module.exports = { shapeBandOverview };
