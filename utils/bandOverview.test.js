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

describe('shapeBandOverview — next show per country', () => {

  it('keys each band\'s soonest show in a country by that country', () => {
    const out = shapeBandOverview(
      [band(1, 'Thrown')], [], [],
      [{ band_id: 1, countries: ['DE', 'DK'] }],
      [
        { band_id: 1, country: 'DE', concert_date: new Date('2026-09-03'), sold_out: false },
        { band_id: 1, country: 'DK', concert_date: new Date('2027-03-01'), sold_out: false },
      ],
    );

    expect(out[0].nextByCountry).toEqual({
      DE: { date: new Date('2026-09-03'), soldOut: false },
      DK: { date: new Date('2027-03-01'), soldOut: false },
    });
  });

  it('carries the sold-out flag per country, not just for the global next show', () => {
    // The near-you show is the one the table now leads with, so its own
    // sold_out is what the badge has to read — the global next show's flag
    // says nothing about the gig you would actually go to.
    const out = shapeBandOverview(
      [band(1, 'Thrown')], [], [], [],
      [
        { band_id: 1, country: 'DE', concert_date: new Date('2026-09-03'), sold_out: false },
        { band_id: 1, country: 'DK', concert_date: new Date('2027-03-01'), sold_out: true },
      ],
    );

    expect(out[0].nextByCountry.DK.soldOut).toBe(true);
  });

  it('is an empty object for a band with nothing coming up', () => {
    // An object either way, so the client can look a country up without a guard.
    const [out] = shapeBandOverview([band(1, 'Sleep Token')], [], [], [], []);

    expect(out.nextByCountry).toEqual({});
  });

  it('holds several bands apart', () => {
    const out = shapeBandOverview(
      [band(1, 'Thrown'), band(2, 'Polaris')], [], [], [],
      [
        { band_id: 1, country: 'DE', concert_date: new Date('2026-09-03'), sold_out: false },
        { band_id: 2, country: 'DK', concert_date: new Date('2026-10-01'), sold_out: false },
      ],
    );

    expect(Object.keys(out[0].nextByCountry)).toEqual(['DE']);
    expect(Object.keys(out[1].nextByCountry)).toEqual(['DK']);
  });

  it('reads a band id that arrives as a string', () => {
    // Same driver quirk the other raw-SQL rows hit: this query is one row per
    // band and country, so it cannot go through byBandId and needs its own
    // coercion.
    const out = shapeBandOverview(
      [band(1, 'Thrown')], [], [], [],
      [{ band_id: '1', country: 'DE', concert_date: new Date('2026-09-03'), sold_out: false }],
    );

    expect(out[0].nextByCountry.DE.date).toEqual(new Date('2026-09-03'));
  });

  it('ignores rows for bands that are not in the list', () => {
    const out = shapeBandOverview(
      [band(1, 'Thrown')], [], [], [],
      [{ band_id: 99, country: 'ES', concert_date: new Date('2026-09-03'), sold_out: false }],
    );

    expect(out[0].nextByCountry).toEqual({});
  });

  it('leaves the global next show alone, because it may be in a null country', () => {
    // nextByCountry drops null-country concerts, so it is not a superset of the
    // global next show and cannot replace it.
    const out = shapeBandOverview(
      [band(1, 'Thrown')],
      [{ band_id: 1, concert_date: new Date('2026-08-01'), country: null }],
      [], [], [],
    );

    expect(out[0].nextConcertDate).toEqual(new Date('2026-08-01'));
    expect(out[0].nextByCountry).toEqual({});
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
