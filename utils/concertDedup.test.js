import { describe, it, expect, vi } from 'vitest';
import { haversineKm, stringSimilarity, venueContains, detectFestivalCluster, deduplicateByCoords, deduplicateConcerts, checkDuplicateConcert } from './concertDedup.js';

describe('haversineKm', () => {
  it('is 0 for the same point', () => {
    expect(haversineKm(48.8566, 2.3522, 48.8566, 2.3522)).toBe(0);
  });

  it('is roughly 111km per degree of latitude', () => {
    expect(haversineKm(0, 0, 1, 0)).toBeCloseTo(111.2, 0);
  });
});

describe('stringSimilarity', () => {
  it('is 1 for identical strings', () => {
    expect(stringSimilarity('Wacken Open Air', 'Wacken Open Air')).toBe(1);
  });

  it('is case- and punctuation-insensitive', () => {
    expect(stringSimilarity('Booking.com', 'BOOKING COM')).toBe(1);
  });

  it('is 0 when either string is empty after normalization', () => {
    expect(stringSimilarity('', 'Venue')).toBe(0);
    expect(stringSimilarity('!!!', 'Venue')).toBe(0);
  });

  it('is 0 for completely unrelated strings', () => {
    expect(stringSimilarity('Zenith De Paris', 'Xyzabc Qwerty')).toBeLessThan(0.3);
  });

  it('scores high for a near-identical string with one typo', () => {
    expect(stringSimilarity('Resurrection Fest', 'Resurection Fest')).toBeGreaterThan(0.85);
  });
});

describe('venueContains', () => {
  it('is true when the shorter name is contained in the longer one', () => {
    expect(venueContains('Zenith De Nancy - Amphitheatre Plein Air', 'Amphitheatre Plein Air')).toBe(true);
  });

  it('is false when the shorter fragment is under 10 chars, even if contained', () => {
    expect(venueContains('Zenith De Nancy', 'Zenith')).toBe(false);
  });

  it('is false for unrelated venue names', () => {
    expect(venueContains('Zenith De Nancy', 'Wacken Festivalgelaende')).toBe(false);
  });
});

describe('detectFestivalCluster', () => {
  // Bandsintown scrapes a festival as one page per artist, so no single
  // incoming row's own bill is ever big enough on its own — the signal only
  // shows up once you look at every stored row sharing the event name.
  const stageRow = (id, band, over = {}) => ({
    id,
    name: 'Graspop Metal Meeting 2025',
    city: 'Dessel',
    concert_date: new Date('2025-06-20T00:00:00Z'),
    bands: [{ band }],
    ...over,
  });

  it('is false when nothing nearby shares the event name', () => {
    const incoming = { name: 'grandson @ Graspop Metal Meeting 2025', city: 'Dessel', concert_date: '2025-06-20T00:00:00Z' };
    const { isFestival, matches } = detectFestivalCluster(incoming, [1], []);
    expect(isFestival).toBe(false);
    expect(matches).toEqual([]);
  });

  it('is false when the incoming concert has no name to cluster by', () => {
    const incoming = { city: 'Dessel', concert_date: '2025-06-20T00:00:00Z' };
    const { isFestival } = detectFestivalCluster(incoming, [1], [stageRow(1, 2)]);
    expect(isFestival).toBe(false);
  });

  it('is true once the matched rows span more than one calendar day', () => {
    const incoming = { name: 'Slipknot @ Graspop Metal Meeting 2025', city: 'Dessel', concert_date: '2025-06-21T00:00:00Z' };
    const matches = [stageRow(1, 2, { concert_date: new Date('2025-06-20T00:00:00Z') })];
    const { isFestival } = detectFestivalCluster(incoming, [3], matches);
    expect(isFestival).toBe(true);
  });

  it('is true once the bands across the matched rows add up past five, same day', () => {
    const incoming = { name: 'Poppy @ Graspop Metal Meeting 2025', city: 'Dessel', concert_date: '2025-06-20T00:00:00Z' };
    const matches = [1, 2, 3, 4].map((id) => stageRow(id, id + 10));
    const { isFestival } = detectFestivalCluster(incoming, [99], matches);
    // 4 matched bands + the incoming band = 5.
    expect(isFestival).toBe(true);
  });

  it('is false when the bill stays small and confined to one day', () => {
    const incoming = { name: 'Nordic Noise 2026', venue: 'Amager Bio', city: 'Copenhagen', concert_date: '2026-06-01T00:00:00Z' };
    const matches = [{ id: 1, name: 'Nordic Noise 2026', venue: 'Amager Bio', city: 'Copenhagen', concert_date: new Date('2026-06-01T00:00:00Z'), bands: [{ band: 2 }] }];
    const { isFestival } = detectFestivalCluster(incoming, [1], matches);
    expect(isFestival).toBe(false);
  });

  // The regression that made the venue check necessary: normalizeEventName
  // strips the artist prefix, so a band's second night in the same room
  // reduced to the identical "fallan" as its first and read as a two-day
  // festival — merging two concerts the rest of this file works to keep apart.
  it('does not read a band\'s second night at one venue as a festival', () => {
    const incoming = { name: 'THROWN @ Fållan', venue: 'Fållan', city: 'Johanneshov', concert_date: '2026-11-28T19:00:00Z' };
    const matches = [{ id: 1, name: 'THROWN @ Fållan', venue: 'Fållan', city: 'Johanneshov', concert_date: new Date('2026-11-27T19:00:00Z'), bands: [{ band: 93 }] }];
    const { isFestival, matches: kept } = detectFestivalCluster(incoming, [93], matches);
    expect(kept).toEqual([]);
    expect(isFestival).toBe(false);
  });

  // The other side of that check: an artist-centric listing whose "@" leads
  // to the festival rather than the field it is held on is exactly the row
  // the scraper's own bill-length rule cannot flag, and must survive.
  it('still clusters an artist-centric listing named for the festival', () => {
    const incoming = { name: 'Slipknot @ Graspop Metal Meeting 2025', venue: 'Festivalterrein Stenehei', city: 'Dessel', concert_date: '2025-06-21T00:00:00Z' };
    const matches = [stageRow(1, 2, { venue: 'South Stage', name: 'Poppy @ Graspop Metal Meeting 2025' })];
    const { isFestival } = detectFestivalCluster(incoming, [3], matches);
    expect(isFestival).toBe(true);
  });

  // Found by running the backfill against real rows: an event named for the
  // band itself carries no "@" at all, so the venue check above never saw it,
  // and two Leeds dates a week apart read as a two-day festival.
  it('does not read a band playing one city twice as a festival', () => {
    const bandRow = (id, day, venue) => ({
      id, name: 'Citizen', venue, city: 'Leeds',
      concert_date: new Date(day),
      bands: [{ band: id, band_rel: { name: 'Citizen' } }],
    });
    const incoming = { name: 'Citizen', venue: 'Stylus', city: 'Leeds', concert_date: '2026-10-25T00:00:00Z' };
    const { isFestival, matches } = detectFestivalCluster(
      incoming, [7], [bandRow(1, '2026-10-21T00:00:00Z', 'Project House')], ['Citizen'],
    );
    expect(matches).toEqual([]);
    expect(isFestival).toBe(false);
  });

  // The same shape from the other direction: the incoming row is not named
  // after its own act, but the stored one is, so it must not be clustered in.
  it('ignores a stored row titled after its own act', () => {
    const incoming = { name: 'Rock The Lakes 2026', venue: 'Rock The Lakes Festival', city: 'Cudrefin', concert_date: '2026-08-16T00:00:00Z' };
    const stored = {
      id: 1, name: 'A$AP Rocky', venue: 'Atlas Arena', city: 'Cudrefin',
      concert_date: new Date('2026-08-14T00:00:00Z'),
      bands: [{ band: 5, band_rel: { name: 'A$AP Rocky' } }],
    };
    const { matches } = detectFestivalCluster(incoming, [3], [stored], ['Imminence']);
    expect(matches).toEqual([]);
  });

  it('leaves out a same-named show in a different city', () => {
    const incoming = { name: 'Graspop Metal Meeting 2025', city: 'Dessel', concert_date: '2025-06-20T00:00:00Z' };
    const matches = [stageRow(1, 2, { city: 'Copenhagen' })];
    const { isFestival, matches: kept } = detectFestivalCluster(incoming, [3], matches);
    expect(kept).toEqual([]);
    expect(isFestival).toBe(false);
  });
});

describe('deduplicateByCoords', () => {
  it('keeps only the entry with the most bands when coordinates coincide', () => {
    const concerts = [
      { latitude: 48.8566, longitude: 2.3522, bands: [1] },
      { latitude: 48.8566, longitude: 2.3522, bands: [1, 2, 3] },
    ];
    const result = deduplicateByCoords(concerts);
    expect(result).toHaveLength(1);
    expect(result[0].bands).toEqual([1, 2, 3]);
  });

  it('keeps concerts at distinct coordinates separate', () => {
    const concerts = [
      { latitude: 48.8566, longitude: 2.3522, bands: [1] },
      { latitude: 51.5074, longitude: -0.1278, bands: [2] },
    ];
    expect(deduplicateByCoords(concerts)).toHaveLength(2);
  });

  it('passes concerts without coordinates through unchanged', () => {
    const concerts = [{ bands: [1] }, { bands: [2] }];
    expect(deduplicateByCoords(concerts)).toHaveLength(2);
  });

  it('keeps both nights of a two-night stand at one venue', () => {
    // The coordinates are identical to the metre; only the day differs. Keyed on
    // position alone this dropped the second night before it reached the DB.
    const concerts = [
      { name: 'Night 1', latitude: 59.2964153, longitude: 18.0755919, concert_date: '2026-11-27T19:00:00Z', bands: [1] },
      { name: 'Night 2', latitude: 59.2964153, longitude: 18.0755919, concert_date: '2026-11-28T19:00:00Z', bands: [1] },
    ];
    expect(deduplicateByCoords(concerts).map((c) => c.name)).toEqual(['Night 1', 'Night 2']);
  });

  it('still collapses two reports of the same show on the same day', () => {
    const concerts = [
      { latitude: 48.8566, longitude: 2.3522, concert_date: '2026-06-01T20:00:00Z', bands: [1] },
      { latitude: 48.8566, longitude: 2.3522, concert_date: '2026-06-01T18:30:00Z', bands: [1, 2, 3] },
    ];
    const result = deduplicateByCoords(concerts);
    expect(result).toHaveLength(1);
    expect(result[0].bands).toEqual([1, 2, 3]);
  });

  it('treats an unparseable date as undated rather than throwing', () => {
    const concerts = [
      { latitude: 48.8566, longitude: 2.3522, concert_date: 'not a date', bands: [1] },
      { latitude: 48.8566, longitude: 2.3522, concert_date: 'also not a date', bands: [1, 2] },
    ];
    const result = deduplicateByCoords(concerts);
    expect(result).toHaveLength(1);
    expect(result[0].bands).toEqual([1, 2]);
  });
});

describe('deduplicateConcerts', () => {
  it('drops a same-event duplicate: matching name, venue, date, and area', () => {
    const concerts = [
      {
        name: 'Imminence @ Trabendo', venue: 'Le Trabendo', city: 'Paris',
        latitude: 48.8619, longitude: 2.3903,
        concert_date: '2026-09-10T20:00:00Z', participating_bands: [{ id: 1 }],
      },
      {
        name: 'Imminence @ Trabendo', venue: 'Le Trabendo', city: 'Paris',
        latitude: 48.8619, longitude: 2.3903,
        concert_date: '2026-09-10T20:00:00Z', participating_bands: [{ id: 1 }],
      },
    ];
    expect(deduplicateConcerts(concerts)).toHaveLength(1);
  });

  it('keeps distinct events at the same venue on different dates', () => {
    const concerts = [
      {
        name: 'Band A', venue: 'Zenith', city: 'Paris',
        latitude: 48.8619, longitude: 2.3903,
        concert_date: '2026-09-10T20:00:00Z', participating_bands: [{ id: 1 }],
      },
      {
        name: 'Band B', venue: 'Zenith', city: 'Paris',
        latitude: 48.8619, longitude: 2.3903,
        concert_date: '2026-11-01T20:00:00Z', participating_bands: [{ id: 2 }],
      },
    ];
    expect(deduplicateConcerts(concerts)).toHaveLength(2);
  });

  it('merges same-day, same-city concerts that share a participating band', () => {
    const concerts = [
      {
        name: 'Opening Act', venue: 'Zenith', city: 'Paris',
        concert_date: '2026-09-10T18:00:00Z',
        participating_bands: [{ id: 1 }],
      },
      {
        name: 'Headline Show', venue: 'Zenith Annex', city: 'Paris',
        concert_date: '2026-09-10T20:00:00Z',
        participating_bands: [{ id: 1 }, { id: 2 }],
      },
    ];
    const result = deduplicateConcerts(concerts);
    expect(result).toHaveLength(1);
    expect(result[0].participating_bands.map((b) => b.id).sort()).toEqual([1, 2]);
  });

  it('does not merge two festivals sharing a band on the same day', () => {
    // Distinct enough names/venues that pass 1 (same-event dedup) leaves both
    // alone — this isolates pass 2's "don't merge festivals" rule specifically.
    const concerts = [
      {
        name: 'Rock Fest', venue: 'City Park', city: 'Berlin', festival: true,
        concert_date: '2026-08-01T12:00:00Z',
        participating_bands: [{ id: 1 }],
      },
      {
        name: 'Metal Mania', venue: 'Olympic Stadium', city: 'Berlin', festival: true,
        concert_date: '2026-08-01T12:00:00Z',
        participating_bands: [{ id: 1 }],
      },
    ];
    expect(deduplicateConcerts(concerts)).toHaveLength(2);
  });

  it('passes concerts with no name, venue, or date straight through', () => {
    const concerts = [{ participating_bands: [] }, { participating_bands: [] }];
    expect(deduplicateConcerts(concerts)).toHaveLength(2);
  });

  it('keeps the headline record when a support act\'s own listing merges into it', () => {
    // The Glasgow rows, in the order the wishlist happened to serve them. The
    // support act's row is a Bandsintown listing under the fallback "Band @
    // Venue" name and the room next door; the headline row is the gig itself.
    // Merging is order-driven, so arriving first used to make the support act's
    // listing the surviving record and title the gig after it.
    const supportListing = {
      id: 13899, name: 'As December Falls @ SWG3 Garden', venue: 'SWG3 Garden', city: 'Glasgow',
      concert_date: '2026-09-08T17:00:00Z', source: 'bandsintown',
      participating_bands: [{ id: 226 }],
    };
    const headlineShow = {
      id: 12818, name: 'Dance Gavin Dance', venue: 'Galvanizers SWG3', city: 'Glasgow',
      concert_date: '2026-09-08T19:00:00Z', source: null,
      participating_bands: [{ id: 75 }, { id: 226 }],
    };

    const [merged] = deduplicateConcerts([supportListing, headlineShow]);

    expect(merged.id).toBe(12818);
    expect(merged.name).toBe('Dance Gavin Dance');
    expect(merged.venue).toBe('Galvanizers SWG3');
    expect(merged.participating_bands.map((b) => b.id).sort((a, b) => a - b)).toEqual([75, 226]);
  });

  it('still keeps the first record when neither name is a fallback', () => {
    const first = {
      id: 1, name: 'Opening Act', venue: 'Zenith', city: 'Paris',
      concert_date: '2026-09-10T18:00:00Z', participating_bands: [{ id: 1 }],
    };
    const second = {
      id: 2, name: 'Headline Show', venue: 'Zenith Annex', city: 'Paris',
      concert_date: '2026-09-10T20:00:00Z', participating_bands: [{ id: 1 }, { id: 2 }],
    };

    expect(deduplicateConcerts([first, second])[0].id).toBe(1);
  });
});

describe('checkDuplicateConcert and a second night at the same venue', () => {
  // A stand-in for the Prisma transaction: findMany supplies the candidate rows,
  // and the merge writes are recorded rather than performed.
  const txWith = (rows) => ({
    concert: { findMany: async () => rows, update: async () => ({}) },
    concertBandReference: { findMany: async () => [], createMany: async () => ({}) },
  });

  const existing = (over = {}) => ({
    id: 1,
    venue: 'Fållan',
    city: 'Johanneshov',
    latitude: '59.2964153',
    longitude: '18.0755919',
    concert_date: new Date('2026-11-27T19:00:00Z'),
    name: 'THROWN @ Fållan',
    source: 'bandsintown',
    festival: false,
    bands: [{ band: 93 }],
    ...over,
  });

  const incoming = (over = {}) => ({
    venue: 'Fållan',
    city: 'Johanneshov',
    latitude: '59.2964153',
    longitude: '18.0755919',
    concert_date: '2026-11-28T19:00:00Z',
    name: 'THROWN @ Fållan',
    source: 'bandsintown',
    festival: false,
    ...over,
  });

  it('treats the next night at the same venue from the same source as a new concert', async () => {
    const { isDuplicate } = await checkDuplicateConcert({
      concert: incoming(),
      bandIds: [93],
      tx: txWith([existing()]),
    });
    expect(isDuplicate).toBe(false);
  });

  it('still merges the same show when two sources date it a day apart', async () => {
    // This is what the day-apart window was for: one show, two sources, a date
    // that slipped over midnight. Different sources, so it must still collapse.
    const { isDuplicate } = await checkDuplicateConcert({
      concert: incoming({ source: 'songkick' }),
      bandIds: [93],
      tx: txWith([existing()]),
    });
    expect(isDuplicate).toBe(true);
  });

  it('still merges the same show reported twice on the same day', async () => {
    const { isDuplicate } = await checkDuplicateConcert({
      concert: incoming({ concert_date: '2026-11-27T20:00:00Z' }),
      bandIds: [93],
      tx: txWith([existing()]),
    });
    expect(isDuplicate).toBe(true);
  });

  it('still merges the days of a multi-day festival from one source', async () => {
    const { isDuplicate } = await checkDuplicateConcert({
      concert: incoming({ festival: true, name: 'Resurrection Fest 2026', venue: 'Campo de Fútbol Celeiro' }),
      bandIds: [93],
      tx: txWith([existing({ festival: true, name: 'Resurrection Fest 2026', venue: 'Campo de Fútbol Celeiro' })]),
    });
    expect(isDuplicate).toBe(true);
  });
});

describe('checkDuplicateConcert upgrading a festival flag it can only see from outside', () => {
  // The stage rows arrive flagged festival: false — Bandsintown's per-band
  // page lists too few acts for the scraper's own rule to fire — so the flag
  // has to be corrected from what the surrounding rows add up to, and written
  // back to those rows too, since none of them can ever work it out alone.
  const txWith = (rows) => {
    const updateMany = vi.fn(async () => ({}));
    return {
      tx: {
        concert: { findMany: async () => rows, update: async () => ({}), updateMany },
        concertBandReference: { findMany: async () => [], createMany: async () => ({}) },
      },
      updateMany,
    };
  };

  const dayOne = {
    id: 1,
    venue: 'South Stage',
    city: 'Dessel',
    concert_date: new Date('2025-06-20T00:00:00Z'),
    name: 'Poppy @ Graspop Metal Meeting 2025',
    source: 'bandsintown',
    festival: false,
    bands: [{ band: 2 }],
  };

  const dayTwo = {
    venue: 'Jupiler Stage',
    city: 'Dessel',
    concert_date: '2025-06-21T00:00:00Z',
    name: 'Slipknot @ Graspop Metal Meeting 2025',
    source: 'bandsintown',
    festival: false,
  };

  it('flags the incoming concert once the days under one event name add up', async () => {
    const concert = { ...dayTwo };
    const { tx } = txWith([dayOne]);
    await checkDuplicateConcert({ concert, bandIds: [3], tx });
    expect(concert.festival).toBe(true);
  });

  it('writes the flag back to the stored rows that could not see it either', async () => {
    const { tx, updateMany } = txWith([dayOne]);
    await checkDuplicateConcert({ concert: { ...dayTwo }, bandIds: [3], tx });
    expect(updateMany).toHaveBeenCalledWith({ where: { id: { in: [1] } }, data: { festival: true } });
  });

  it('leaves an ordinary two-night run alone', async () => {
    const concert = { venue: 'Fållan', city: 'Johanneshov', concert_date: '2026-11-28T19:00:00Z', name: 'THROWN @ Fållan', source: 'bandsintown', festival: false };
    const { tx, updateMany } = txWith([{
      id: 9, venue: 'Fållan', city: 'Johanneshov', concert_date: new Date('2026-11-27T19:00:00Z'), name: 'THROWN @ Fållan', source: 'bandsintown', festival: false, bands: [{ band: 93 }],
    }]);
    await checkDuplicateConcert({ concert, bandIds: [93], tx });
    expect(concert.festival).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('deduplicateConcerts — adopting a time from a duplicate', () => {
  // Two sources describing the same gig. Songkick is scraped first and so
  // becomes the base, but 182 of its rows carry no time at all.
  const pair = (baseDate, incomingDate, over = {}) => ([
    {
      name: 'THROWN @ Fållan', venue: 'Fållan', city: 'Stockholm',
      source: 'songkick', concert_date: baseDate,
      participating_bands: [{ id: 1 }],
    },
    {
      name: 'thrown official @ Fållan', venue: 'Fållan', city: 'Stockholm',
      source: 'bandsintown', concert_date: incomingDate,
      participating_bands: [{ id: 1 }],
      ...over,
    },
  ]);

  it('takes the duplicate\'s time when the base has none', () => {
    // Without this the 19:00 is thrown away and the gig stays an all-day event
    // purely because of which scraper happened to run first.
    const [merged] = deduplicateConcerts(pair('2026-11-27T00:00:00Z', '2026-11-27T19:00:00Z'));
    expect(new Date(merged.concert_date).toISOString()).toBe('2026-11-27T19:00:00.000Z');
  });

  it('takes the source along with the time, so the two cannot disagree', () => {
    // A Bandsintown time is a wall clock; a Songkick time is a real instant.
    // Keeping source: 'songkick' on a row now holding a Bandsintown time would
    // make the calendar read it as UTC and render the gig hours out.
    const [merged] = deduplicateConcerts(pair('2026-11-27T00:00:00Z', '2026-11-27T19:00:00Z'));
    expect(merged.source).toBe('bandsintown');
  });

  it('keeps the base time when it already has one', () => {
    const [merged] = deduplicateConcerts(pair('2026-11-27T18:00:00Z', '2026-11-27T19:00:00Z'));
    expect(new Date(merged.concert_date).toISOString()).toBe('2026-11-27T18:00:00.000Z');
    expect(merged.source).toBe('songkick');
  });

  it('leaves the day alone when neither side has a time', () => {
    const [merged] = deduplicateConcerts(pair('2026-11-27T00:00:00Z', '2026-11-27T00:00:00Z'));
    expect(new Date(merged.concert_date).toISOString()).toBe('2026-11-27T00:00:00.000Z');
    expect(merged.source).toBe('songkick');
  });

  it('still merges the lineups when it adopts a time', () => {
    // The time is extra behaviour, not a replacement for what merging already
    // did.
    const [merged] = deduplicateConcerts(pair('2026-11-27T00:00:00Z', '2026-11-27T19:00:00Z', {
      participating_bands: [{ id: 1 }, { id: 2 }],
    }));
    expect(merged.participating_bands.map((b) => b.id).sort()).toEqual([1, 2]);
  });
});
