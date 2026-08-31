import { describe, it, expect } from 'vitest';
import { shapeBandOverview } from './bandOverview.js';

const band = (id, name, over = {}) => ({
  id,
  name,
  songkick_url: null,
  bandsintown_url: null,
  _count: { concerts: 0 },
  ...over,
});

describe('shapeBandOverview', () => {

  it('carries the band through with its upcoming-concert count', () => {
    const out = shapeBandOverview([band(1, 'Silverstein', { _count: { concerts: 4 } })], [], [], []);

    expect(out).toEqual([expect.objectContaining({ id: 1, name: 'Silverstein', concertCount: 4 })]);
  });

  it('attaches the next concert to the band that is playing it', () => {
    const out = shapeBandOverview(
      [band(1, 'Silverstein'), band(2, 'Polaris')],
      [{ band_id: 2, concert_date: new Date('2026-10-01'), country: 'DE' }],
      [],
    );

    expect(out[0].nextConcertDate).toBeNull();
    expect(out[1].nextConcertDate).toEqual(new Date('2026-10-01'));
    expect(out[1].nextConcertCountry).toBe('DE');
  });

  it('attaches the most recent past concert as the last one seen', () => {
    const out = shapeBandOverview(
      [band(1, 'Silverstein')],
      [],
      [{ band_id: 1, concert_date: new Date('2024-05-10'), country: 'BE' }],
    );

    expect(out[0].lastConcertDate).toEqual(new Date('2024-05-10'));
    expect(out[0].lastConcertCountry).toBe('BE');
  });

  it('gives every band all four fields even with nothing to put in them', () => {
    // The table renders a column per field. A band with no concerts at all has
    // to come back with explicit nulls, or the row renders `undefined`.
    const [out] = shapeBandOverview([band(1, 'Sleep Token')], [], []);

    expect(out.nextConcertDate).toBeNull();
    expect(out.nextConcertCountry).toBeNull();
    expect(out.lastConcertDate).toBeNull();
    expect(out.lastConcertCountry).toBeNull();
  });

  it('does not leak the raw _count through to the client', () => {
    const [out] = shapeBandOverview([band(1, 'Spiritbox', { _count: { concerts: 2 } })], [], []);

    expect(out._count).toBeUndefined();
  });

  it('ignores rows for bands that are not in the list', () => {
    // The two concert queries are not scoped to the band page, so they can
    // return a band that was filtered out. Indexing by the band list rather
    // than by the rows keeps a stray row from inventing an entry.
    const out = shapeBandOverview(
      [band(1, 'Silverstein')],
      [{ band_id: 99, concert_date: new Date('2026-10-01'), country: 'DE' }],
      [],
    );

    expect(out).toHaveLength(1);
    expect(out[0].nextConcertDate).toBeNull();
  });

  it('reads a band id that arrives as a string', () => {
    // Raw SQL through the driver can hand back an id as a string; a Map keyed
    // on a number would then miss every row and the whole column would be
    // silently empty.
    const out = shapeBandOverview(
      [band(1, 'Silverstein')],
      [{ band_id: '1', concert_date: new Date('2026-10-01'), country: 'DE' }],
      [],
    );

    expect(out[0].nextConcertCountry).toBe('DE');
  });

  it('keeps the source links the missing-links badge reads', () => {
    const [out] = shapeBandOverview(
      [band(1, 'Thrown', { songkick_url: 'https://songkick/x', bandsintown_url: null })],
      [], [],
    );

    expect(out.songkick_url).toBe('https://songkick/x');
    expect(out.bandsintown_url).toBeNull();
  });

  it('lists every country a band is touring, not just the next one', () => {
    // The table used to show only the next concert's country, so a band playing
    // Germany, the Netherlands and Belgium read as a German band.
    const out = shapeBandOverview(
      [band(1, 'Thrown')], [], [],
      [{ band_id: 1, countries: ['DE', 'NL', 'BE'] }],
    );

    expect(out[0].touringCountries).toEqual(['DE', 'NL', 'BE']);
  });

  it('gives a band with nothing coming up an empty touring list', () => {
    // An array either way, so the column can map over it without a guard.
    const [out] = shapeBandOverview([band(1, 'Sleep Token')], [], [], []);

    expect(out.touringCountries).toEqual([]);
  });

  it('drops nulls out of the touring list', () => {
    // Concerts carry a null country, and array_agg keeps it — a null would
    // render as a stray empty flag in the column.
    const out = shapeBandOverview(
      [band(1, 'Thrown')], [], [],
      [{ band_id: 1, countries: ['DE', null, 'NL'] }],
    );

    expect(out[0].touringCountries).toEqual(['DE', 'NL']);
  });

});

describe('shapeBandOverview — sold out', () => {
  const band = (id, name) => ({ id, name, songkick_url: null, bandsintown_url: null, _count: { concerts: 1 } });

  it('flags a next show that is sold out', () => {
    const out = shapeBandOverview(
      [band(1, 'Spiritbox')],
      [{ band_id: 1, concert_date: new Date('2026-10-01'), country: 'DE', sold_out: true }],
      [], [],
    );

    expect(out[0].nextConcertSoldOut).toBe(true);
  });

  it('is false rather than undefined when nothing says otherwise', () => {
    // No scraper currently sets sold_out — it is false on all 1002 rows — so
    // this is the case that actually ships. It has to be a boolean the table
    // can test, not undefined.
    const out = shapeBandOverview(
      [band(1, 'Spiritbox')],
      [{ band_id: 1, concert_date: new Date('2026-10-01'), country: 'DE' }],
      [], [],
    );

    expect(out[0].nextConcertSoldOut).toBe(false);
  });

  it('is false for a band with no next show at all', () => {
    const [out] = shapeBandOverview([band(1, 'Sleep Token')], [], [], []);

    expect(out.nextConcertSoldOut).toBe(false);
  });
});

describe('nextByCity', () => {
  const row = (over = {}) => ({
    band_id: '1', concert_id: 10, concert_date: new Date('2026-09-03'), sold_out: false,
    country: 'DK', city: 'Copenhagen',
    city_lat: 55.6761, city_lng: 12.5683, raw_lat: null, raw_lng: null,
    ...over,
  });

  it('gives every city the band plays its soonest show, soonest first', () => {
    const out = shapeBandOverview([{ id: 1, name: 'Opeth' }], [], [], [], [
      row({ concert_id: 11, city: 'Malmö', country: 'SE', concert_date: new Date('2026-09-17') }),
      row({ concert_id: 10, city: 'Copenhagen', concert_date: new Date('2026-09-03') }),
    ]);

    expect(out[0].nextByCity.map((s) => s.city)).toEqual(['Copenhagen', 'Malmö']);
  });

  it('prefers the City row position over the concert\'s own', () => {
    // City has clean Float coordinates and a unique name/country pair; the
    // concert's pair is a VarChar filled by whichever scraper got there first.
    const out = shapeBandOverview([{ id: 1, name: 'Opeth' }], [], [], [], [
      row({ city_lat: 55.6761, city_lng: 12.5683, raw_lat: '1.0', raw_lng: '2.0' }),
    ]);

    expect(out[0].nextByCity[0]).toMatchObject({ lat: 55.6761, lng: 12.5683 });
  });

  it('falls back to the concert\'s own position when the city has none', () => {
    const out = shapeBandOverview([{ id: 1, name: 'Opeth' }], [], [], [], [
      row({ city_lat: null, city_lng: null, raw_lat: '55.6761', raw_lng: '12.5683' }),
    ]);

    expect(out[0].nextByCity[0]).toMatchObject({ lat: 55.6761, lng: 12.5683 });
  });

  it('keeps a show whose position is unknown, with nulls', () => {
    // Dropping it would lose a real concert from the "elsewhere" column. The
    // client's near-me rule already refuses to call an unknown position near.
    const out = shapeBandOverview([{ id: 1, name: 'Opeth' }], [], [], [], [
      row({ city_lat: null, city_lng: null, raw_lat: null, raw_lng: null }),
    ]);

    expect(out[0].nextByCity[0]).toMatchObject({ city: 'Copenhagen', lat: null, lng: null });
  });

  it('survives a coordinate a scraper wrote as prose', () => {
    // The reason this resolves in JavaScript rather than a SQL ::float cast:
    // one bad row must not take down the whole query and empty the overview.
    const out = shapeBandOverview([{ id: 1, name: 'Opeth' }], [], [], [], [
      row({ city_lat: null, city_lng: null, raw_lat: 'somewhere', raw_lng: 'else' }),
    ]);

    expect(out[0].nextByCity[0]).toMatchObject({ lat: null, lng: null });
  });

  it('is an empty array for a band with no upcoming shows', () => {
    const out = shapeBandOverview([{ id: 1, name: 'Opeth' }], [], [], [], []);

    expect(out[0].nextByCity).toEqual([]);
  });
});

describe('shapeBandOverview band photos', () => {
  it('attaches the photo belonging to the band matched to that Spotify artist', () => {
    const out = shapeBandOverview(
      [band(1, 'Spiritbox', { spotify_id: 'sb' }), band(2, 'Polaris', { spotify_id: 'pl' })],
      [], [], [], [],
      { sb: 'spiritbox.jpg' },
    );

    expect(out[0].image).toBe('spiritbox.jpg');
    // Matched to Spotify but photoless, which is not the same as unmatched.
    expect(out[1].image).toBeNull();
  });

  // Every other field on a row is present whatever happens, so the avatar has
  // one thing to test rather than two.
  it('gives a band that was never matched a null photo rather than no field', () => {
    const [out] = shapeBandOverview([band(1, 'Sleep Token')], [], [], [], [], {});

    expect(out).toHaveProperty('image', null);
  });

  it('leaves every photo null when the images could not be resolved at all', () => {
    const [out] = shapeBandOverview([band(1, 'Sleep Token', { spotify_id: 'st' })], [], [], []);

    expect(out.image).toBeNull();
  });
});

describe('shapeBandOverview — concert ids per city', () => {
  const row = (over = {}) => ({
    band_id: '1', concert_id: 412, concert_date: new Date('2026-11-28'), sold_out: false,
    country: 'SE', city: 'Stockholm',
    city_lat: null, city_lng: null, raw_lat: null, raw_lng: null,
    ...over,
  });

  it('carries the concert id, which is how the client knows you are going', () => {
    const out = shapeBandOverview(
      [band(1, 'Thrown')], [], [], [],
      [row()],
    );

    expect(out[0].nextByCity[0].id).toBe(412);
  });

  it('is null rather than undefined when the row has no id', () => {
    const out = shapeBandOverview(
      [band(1, 'Thrown')], [], [], [],
      [row({ concert_id: null })],
    );

    expect(out[0].nextByCity[0].id).toBeNull();
  });
});

describe('shapeBandOverview — the Spotify artist id', () => {
  it('carries the id through, so a row can link to the artist without a second fetch', () => {
    const [out] = shapeBandOverview([band(1, 'Spiritbox', { spotify_id: '2p1fiYHY' })], [], [], []);

    expect(out.spotifyId).toBe('2p1fiYHY');
  });

  // Explicitly null for the same reason as `image` above: the row reads one
  // value and falls back to a name search, and `undefined` reads as neither.
  it('is null rather than absent for a band Spotify has nothing for', () => {
    const [out] = shapeBandOverview([band(1, 'Some Local Support')], [], [], []);

    expect(out.spotifyId).toBeNull();
  });

  // The photo needs both an id and a resolved image; the link needs only the
  // id. Keeping them independent is what lets an unmatched-looking row — a
  // monogram, because Spotify had no photo — still link to the right artist.
  it('survives on a band whose id resolved to no photo', () => {
    const [out] = shapeBandOverview([band(1, 'Thrown', { spotify_id: 'th1' })], [], [], [], [], {});

    expect(out.image).toBeNull();
    expect(out.spotifyId).toBe('th1');
  });
});
