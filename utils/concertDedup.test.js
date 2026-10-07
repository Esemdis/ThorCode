import { describe, it, expect, vi } from 'vitest';
import { haversineKm, stringSimilarity, venueContains, detectFestivalCluster, deduplicateByCoords, deduplicateConcerts, checkDuplicateConcert, mergedFields } from './concertDedup.js';

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

  it('folds the dropped source\'s tickets, bill and name into the survivor', () => {
    // One band on each row, so the bill length ties and the first — Songkick,
    // which the job scrapes first — survives. Everything Bandsintown saw of
    // the show used to go with the row it was on.
    const concerts = [
      {
        source: 'songkick', name: 'Slipknot @ Festivalgelände', bands: [1], url: null,
        latitude: 54.0247, longitude: 9.3733, concert_date: '2026-07-30T18:00:00Z',
        on_sale: true, sold_out: false, ticket_sale_start: '2026-02-01T00:00:00Z',
        price_min: null, metadata: null, festival: false,
      },
      {
        source: 'bandsintown', name: 'Wacken Open Air 2026', bands: [1], url: 'https://bit/e/1',
        latitude: 54.0247, longitude: 9.3733, concert_date: '2026-07-30T20:00:00Z',
        on_sale: false, sold_out: true, ticket_sale_start: null,
        price_min: 280, price_max: 320, price_currency: 'EUR',
        metadata: JSON.stringify(['Slipknot', 'Megadeth', 'Testament']), festival: true,
      },
    ];
    const [merged, ...rest] = deduplicateByCoords(concerts);
    expect(rest).toEqual([]);
    // The survivor's own date and source, untouched: which of the two a stored
    // time means is read back off the source.
    expect(merged.source).toBe('songkick');
    expect(merged.concert_date).toBe('2026-07-30T18:00:00Z');
    expect(merged.sold_out).toBe(true);
    expect(merged.on_sale).toBe(false);
    expect(merged.ticket_sale_start).toBe('2026-02-01T00:00:00Z');
    expect(merged.price_min).toBe(280);
    expect(merged.price_currency).toBe('EUR');
    expect(JSON.parse(merged.metadata)).toEqual(['Slipknot', 'Megadeth', 'Testament']);
    expect(merged.festival).toBe(true);
    expect(merged.name).toBe('Wacken Open Air 2026');
    expect(merged.url).toBe('https://bit/e/1');
  });

  it('does not let a source with nothing to say clear what the other saw', () => {
    const concerts = [
      {
        name: 'Graspop Metal Meeting 2026', bands: [1], latitude: 51.24, longitude: 5.11,
        concert_date: '2026-06-18T12:00:00Z', on_sale: true, sold_out: false,
        ticket_sale_start: '2026-01-10T00:00:00Z',
        metadata: JSON.stringify(['Korn', 'Gojira']),
      },
      {
        name: 'Korn @ Festivalpark', bands: [1], latitude: 51.24, longitude: 5.11,
        concert_date: '2026-06-18T14:00:00Z', on_sale: false, sold_out: false,
        ticket_sale_start: null, metadata: JSON.stringify(['Korn']),
      },
    ];
    const [merged] = deduplicateByCoords(concerts);
    expect(merged.on_sale).toBe(true);
    expect(merged.sold_out).toBe(false);
    expect(merged.ticket_sale_start).toBe('2026-01-10T00:00:00Z');
    expect(JSON.parse(merged.metadata)).toEqual(['Korn', 'Gojira']);
    expect(merged.name).toBe('Graspop Metal Meeting 2026');
  });

  it('leaves the tickets unsaid when neither source said anything', () => {
    // null is not "no": both sites mark a listing in stock by default, so a
    // scraper with nothing specific to report sends nothing, and the stored
    // row must keep what it had rather than be told false.
    const concerts = [
      { bands: [1], latitude: 51.24, longitude: 5.11, concert_date: '2026-06-18T12:00:00Z', on_sale: null, sold_out: null },
      { bands: [1], latitude: 51.24, longitude: 5.11, concert_date: '2026-06-18T14:00:00Z', on_sale: null, sold_out: null },
    ];
    const [merged] = deduplicateByCoords(concerts);
    expect(merged.on_sale).toBeNull();
    expect(merged.sold_out).toBeNull();
    expect(merged.ticket_sale_start).toBeNull();
  });

  it('keeps two shows apart when neither has a usable coordinate', () => {
    // Non-null nonsense used to round to one "NaN:NaN" cell, so two unrelated
    // shows on a day shared a bucket and one of them never reached the DB.
    const concerts = [
      { name: 'Paris', latitude: '', longitude: '', concert_date: '2026-06-01T20:00:00Z', bands: [1] },
      { name: 'Oslo', latitude: 'N/A', longitude: 'N/A', concert_date: '2026-06-01T19:00:00Z', bands: [2, 3] },
    ];
    expect(deduplicateByCoords(concerts).map((c) => c.name)).toEqual(['Paris', 'Oslo']);
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

describe('checkDuplicateConcert and what the tickets are doing', () => {
  // A festival is one stored row that each act's scrape merges into. The
  // ticket fields used to ride along with the band count, so the scrape that
  // saw "on sale 9 Oct" only recorded it when it also had the longer bill.
  const stored = {
    id: 55, name: 'Copenhell 2027', venue: 'Refshaleøen', city: 'Copenhagen', country: 'DK',
    concert_date: new Date('2027-06-17T00:00:00Z'), latitude: '55.69', longitude: '12.61',
    festival: true, source: 'songkick', on_sale: true, sold_out: false, ticket_sale_start: null,
    bands: [{ band: 1, band_rel: { name: 'Opeth' } }, { band: 2, band_rel: { name: 'Gojira' } }],
  };
  const incoming = (over) => ({
    name: 'Copenhell 2027', venue: 'Refshaleøen', city: 'Copenhagen', country: 'DK',
    concert_date: '2027-06-17T00:00:00Z', latitude: '55.69', longitude: '12.61', festival: true,
    source: 'songkick', ...over,
  });
  const written = (tx) => tx.concert.update.mock.calls.map(([{ data }]) => data);

  const fakeTx = () => ({
    concert: { findMany: vi.fn(async () => [stored]), update: vi.fn(async () => ({})) },
    concertBandReference: { findMany: vi.fn(async () => []), createMany: vi.fn(async () => ({})) },
  });

  it('records a sell-out found by a scrape with a shorter bill', async () => {
    const tx = fakeTx();

    await checkDuplicateConcert({ concert: incoming({ sold_out: true, on_sale: false }), bandIds: [1], tx });

    expect(written(tx)[0]).toMatchObject({ sold_out: true, on_sale: false });
  });

  it('records the day a sale opens, from the one scrape that saw it', async () => {
    const tx = fakeTx();

    await checkDuplicateConcert({
      concert: incoming({ on_sale: false, sold_out: false, ticket_sale_start: '2099-10-09' }), bandIds: [1], tx,
    });

    expect(written(tx)[0]).toMatchObject({ ticket_sale_start: new Date('2099-10-09T00:00:00Z'), on_sale: false });
  });

  it('writes nothing at all when there is no news of any kind', async () => {
    const tx = fakeTx();

    await checkDuplicateConcert({ concert: incoming({ on_sale: true, sold_out: false }), bandIds: [1], tx });

    expect(tx.concert.update).not.toHaveBeenCalled();
  });
});

describe('checkDuplicateConcert and the bill it merges in', () => {
  // The lineup used to ride along with the band count, like the ticket fields
  // above: a scrape that named a new act went unstored unless it also happened
  // to have more of those acts matched to a Band row. A festival's new acts
  // mostly have no Band row, so the bill a follower's alert reads never moved.
  const stored = (metadata) => ({
    id: 55, name: 'Copenhell 2027', venue: 'Refshaleøen', city: 'Copenhagen', country: 'DK',
    concert_date: new Date('2027-06-17T00:00:00Z'), latitude: '55.69', longitude: '12.61',
    festival: true, source: 'songkick', on_sale: true, sold_out: false, ticket_sale_start: null,
    metadata,
    bands: [{ band: 1, band_rel: { name: 'Opeth' } }, { band: 2, band_rel: { name: 'Gojira' } }],
  });
  const incoming = (metadata) => ({
    name: 'Copenhell 2027', venue: 'Refshaleøen', city: 'Copenhagen', country: 'DK',
    concert_date: '2027-06-17T00:00:00Z', latitude: '55.69', longitude: '12.61', festival: true,
    source: 'songkick', on_sale: true, sold_out: false, metadata,
  });
  const fakeTx = (row) => ({
    concert: { findMany: vi.fn(async () => [row]), update: vi.fn(async () => ({})) },
    concertBandReference: { findMany: vi.fn(async () => []), createMany: vi.fn(async () => ({})) },
  });
  const written = (tx) => tx.concert.update.mock.calls.map(([{ data }]) => data);

  it('stores an act joining the bill though it has no Band row to count', async () => {
    const tx = fakeTx(stored('["Opeth","Gojira"]'));

    // One band id: fewer than the two the row already has, so nothing here
    // wins on the old count.
    await checkDuplicateConcert({ concert: incoming('["Opeth","Gojira","Alcest"]'), bandIds: [1], tx });

    expect(written(tx)[0]).toMatchObject({ metadata: '["Opeth","Gojira","Alcest"]' });
  });

  it('keeps the longer bill when the scrape with more linked bands saw less of it', async () => {
    // And writes nothing at all for it: a scrape with more bands than the row
    // used to rewrite the row's date, link and flag on that alone.
    const tx = fakeTx(stored('["Opeth","Gojira","Alcest","Mgla"]'));

    await checkDuplicateConcert({ concert: incoming('["Opeth"]'), bandIds: [1, 2, 3], tx });

    expect(tx.concert.update).not.toHaveBeenCalled();
  });

  it('cleans the scrape before storing it, as every other writer does', async () => {
    const tx = fakeTx(stored(null));

    await checkDuplicateConcert({ concert: incoming('["Counterparts266K Followers"]'), bandIds: [1], tx });

    expect(written(tx)[0]).toMatchObject({ metadata: '["Counterparts"]' });
  });

  it('writes nothing for the same bill spelled differently', async () => {
    const tx = fakeTx(stored('["Architects"]'));

    await checkDuplicateConcert({ concert: incoming('["Architects (UK)"]'), bandIds: [1], tx });

    expect(tx.concert.update).not.toHaveBeenCalled();
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

describe('checkDuplicateConcert and one venue name in two cities', () => {
  // A venue brand with a room in each city — "Zenith", "O2 Academy" — used to
  // be matched on its name alone, with nothing asking whether the two rows were
  // anywhere near each other. A tour playing two of them on consecutive nights
  // lost one of the two concerts.
  const tx = (rows) => ({
    concert: { findMany: async () => rows, update: async () => ({}), updateMany: async () => ({}) },
    concertBandReference: { findMany: async () => [], createMany: async () => ({}) },
  });

  // No names on either row, so this is the venue rule and nothing else, and
  // the two sources differ: one source listing two days is a second night,
  // which is a rule of its own.
  const zenith = (over) => ({ name: null, venue: 'Zenith', festival: false, ...over });
  const paris = {
    id: 1, city: 'Paris', latitude: '48.8936', longitude: '2.3930', source: 'songkick',
    concert_date: new Date('2026-03-10T19:00:00Z'), bands: [{ band: 5 }],
  };

  it('keeps two nights of one tour at that name, 280km apart', async () => {
    const { isDuplicate } = await checkDuplicateConcert({
      concert: zenith({
        city: 'Nancy', latitude: '48.6921', longitude: '6.1844', source: 'bandsintown',
        concert_date: '2026-03-11T19:00:00Z',
      }),
      bandIds: [5],
      tx: tx([zenith(paris)]),
    });
    expect(isDuplicate).toBe(false);
  });

  it('still merges two sources\' reports of one night at that venue', async () => {
    const { isDuplicate, existingConcert } = await checkDuplicateConcert({
      concert: zenith({
        city: 'Paris', latitude: '48.8936', longitude: '2.3930', source: 'bandsintown',
        concert_date: '2026-03-10T20:00:00Z',
      }),
      bandIds: [5],
      tx: tx([zenith(paris)]),
    });
    expect(isDuplicate).toBe(true);
    expect(existingConcert.id).toBe(1);
  });

  it('merges into the fullest bill rather than the first row the query returned', async () => {
    // Postgres returns these in no particular order, and the first match won.
    const row = (id, bands) => zenith({
      id, city: 'Paris', latitude: '48.8936', longitude: '2.3930', source: 'songkick',
      concert_date: new Date('2026-03-10T19:00:00Z'), bands,
    });
    const { existingConcert } = await checkDuplicateConcert({
      concert: zenith({
        city: 'Paris', latitude: '48.8936', longitude: '2.3930', source: 'bandsintown',
        concert_date: '2026-03-10T19:00:00Z',
      }),
      bandIds: [5],
      tx: tx([row(2, [{ band: 5 }]), row(9, [{ band: 5 }, { band: 6 }, { band: 7 }])]),
    });
    expect(existingConcert.id).toBe(9);
  });
});

describe('mergedFields', () => {
  const stored = (over = {}) => ({
    id: 1, name: 'Copenhell 2027', venue: 'Refshaleøen', city: 'Copenhagen',
    concert_date: new Date('2027-06-17T00:00:00Z'), source: 'songkick', url: null,
    festival: false, on_sale: false, sold_out: false, ticket_sale_start: null, metadata: null,
    price_min: null, price_max: null, price_currency: null, ...over,
  });
  const scrape = (over = {}) => ({
    name: 'Copenhell 2027', concert_date: '2027-06-17T00:00:00Z', source: 'songkick', ...over,
  });

  it('writes nothing when the scrape has nothing new to say', () => {
    expect(mergedFields(stored(), scrape())).toEqual({});
  });

  it('keeps the stored name when both are the scraper\'s fallback', () => {
    // Each act's own page is titled "<act> @ <festival>", so the row was
    // renamed after whichever of them was scraped last, every sync.
    expect(mergedFields(stored({ name: 'Opeth @ Copenhell' }), scrape({ name: 'Gojira @ Copenhell' }))).toEqual({});
  });

  it('takes a real event name over a fallback', () => {
    expect(mergedFields(stored({ name: 'Opeth @ Copenhell' }), scrape({ name: 'Copenhell 2027' })))
      .toEqual({ name: 'Copenhell 2027' });
  });

  it('raises the festival flag however short the scrape\'s bill, and never lowers it', () => {
    // The flag used to ride along with the band count, so a festival the
    // cluster check had just recognised stayed unflagged on the stored row
    // unless that same scrape also had more bands than it.
    expect(mergedFields(stored(), scrape({ festival: true }))).toEqual({ festival: true });
    expect(mergedFields(stored({ festival: true }), scrape({ festival: false }))).toEqual({});
  });

  it('fills in a missing start time, with the source and link that time belongs to', () => {
    // `source` is what says whether a stored time is a real instant or a wall
    // clock, so a time read under the wrong one renders hours out.
    expect(mergedFields(stored(), scrape({
      concert_date: '2027-06-17T19:00:00Z', source: 'bandsintown', url: 'https://bandsintown.test/e/1',
    }))).toEqual({
      concert_date: new Date('2027-06-17T19:00:00Z'),
      source: 'bandsintown',
      url: 'https://bandsintown.test/e/1',
    });
  });

  it('keeps the time it has, and never moves the day', () => {
    // Two sources dating one show a day apart is why the windows reach across
    // days at all; it is not a reason to move the show.
    const row = stored({ concert_date: new Date('2027-06-17T19:00:00Z') });
    expect(mergedFields(row, scrape({ concert_date: '2027-06-17T20:00:00Z' }))).toEqual({});
    expect(mergedFields(row, scrape({ concert_date: '2027-06-18T20:00:00Z' }))).toEqual({});
  });

  it('lets any source fill a price in, and only the row\'s own change one', () => {
    // Both sources scrape the same show twice a day, and a price each of them
    // quotes differently would otherwise be rewritten back and forth for good.
    expect(mergedFields(stored(), scrape({ source: 'bandsintown', price_min: 280, price_currency: 'EUR' })))
      .toEqual({ price_min: 280, price_currency: 'EUR' });
    expect(mergedFields(stored({ price_min: 280 }), scrape({ source: 'bandsintown', price_min: 410 })))
      .toEqual({});
    expect(mergedFields(stored({ price_min: 280 }), scrape({ price_min: 410 })))
      .toEqual({ price_min: 410 });
  });
});

describe('deduplicateConcerts folding rather than dropping', () => {
  const row = (over) => ({
    name: 'Copenhell 2027', venue: 'Refshaleøen', city: 'Copenhagen',
    latitude: '55.69', longitude: '12.61', concert_date: '2027-06-17T18:00:00Z',
    participating_bands: [], ...over,
  });

  it('keeps a band only the dropped row was linked to', () => {
    // Two sources' rows for one festival, each linked to the one band whose
    // page it was scraped from. The duplicate was dropped whole, and with it
    // the only record that the other band plays this show at all.
    const merged = deduplicateConcerts([
      row({ id: 1, participating_bands: [{ id: 1 }] }),
      row({ id: 2, participating_bands: [{ id: 2 }] }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].participating_bands.map((b) => b.id)).toEqual([1, 2]);
  });

  it('folds the bills of both rows together', () => {
    const merged = deduplicateConcerts([
      row({ id: 1, metadata: '["Opeth","Gojira"]' }),
      row({ id: 2, metadata: '["Gojira","Alcest"]' }),
    ]);

    expect(JSON.parse(merged[0].metadata)).toEqual(['Opeth', 'Gojira', 'Alcest']);
  });

  it('survives a metadata column holding something that is not a bill', () => {
    // metadata is free-form text and older rows hold other things in it.
    // Spreading one of those threw a TypeError out of the wishlist read, for
    // every wishlist holding such a row. The support act's own listing beside
    // its headline show, which is the shape that reaches the merge.
    const merged = deduplicateConcerts([
      {
        id: 1, name: 'As December Falls @ SWG3 Garden', venue: 'SWG3 Garden', city: 'Glasgow',
        concert_date: '2026-09-08T17:00:00Z', metadata: '{"note":"moved indoors"}',
        participating_bands: [{ id: 226 }],
      },
      {
        id: 2, name: 'Dance Gavin Dance', venue: 'Galvanizers SWG3', city: 'Glasgow',
        concert_date: '2026-09-08T19:00:00Z', metadata: '["Opeth"]',
        participating_bands: [{ id: 75 }, { id: 226 }],
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(JSON.parse(merged[0].metadata)).toEqual(['Opeth']);
  });
});
