import { describe, it, expect } from 'vitest';
import { concertTimeKind, nearbyConcerts, nearbyConcertOut } from './concertsNearby.js';

const CPH = { lat: 55.6761, lng: 12.5683 };

const nearbyShowAt = (over = {}) => ({
  id: 1, city: 'Copenhagen', venue: 'Vega', latitude: '55.6677', longitude: '12.5455', city_rel: null, ...over,
});

describe('concertTimeKind', () => {
  it('calls a midnight-UTC stamp date_only, because the scrapers store "no start time" that way', () => {
    expect(concertTimeKind({ concert_date: '2026-11-14T00:00:00.000Z', source: 'songkick' })).toBe('date_only');
  });

  it('calls a Songkick time a real instant', () => {
    expect(concertTimeKind({ concert_date: '2026-11-14T18:00:00.000Z', source: 'songkick' })).toBe('instant');
  });

  it('calls Bandsintown and Ticketmaster times wall-clock, which is the Z-stamped local time', () => {
    expect(concertTimeKind({ concert_date: '2026-11-14T19:00:00.000Z', source: 'bandsintown' })).toBe('wall_clock');
    expect(concertTimeKind({ concert_date: '2026-11-14T19:00:00.000Z', source: 'ticketmaster' })).toBe('wall_clock');
  });

  it('treats an unknown or missing source as wall-clock, the reading that already ships', () => {
    expect(concertTimeKind({ concert_date: '2026-11-14T19:00:00.000Z', source: null })).toBe('wall_clock');
  });

  it('has no time for a missing or unparseable date', () => {
    expect(concertTimeKind({ concert_date: null })).toBe('date_only');
    expect(concertTimeKind({ concert_date: 'soon' })).toBe('date_only');
  });
});

describe('nearbyConcerts', () => {
  it('keeps a venue inside the radius and says how far it is', () => {
    const [kept] = nearbyConcerts([nearbyShowAt()], { ...CPH, radiusKm: 30 });
    expect(kept.match).toBe('distance');
    expect(kept.distance_km).toBeGreaterThan(0.5);
    expect(kept.distance_km).toBeLessThan(2);
    expect(kept.latitude).toBeCloseTo(55.6677);
  });

  it('drops a venue outside the radius even when the city name is the same', () => {
    // Malmö is about 28 km from Copenhagen; Roskilde-side Helsingør is further.
    const far = nearbyShowAt({ latitude: '56.0361', longitude: '12.6136', city: 'Copenhagen' });
    expect(nearbyConcerts([far], { ...CPH, radiusKm: 30, city: 'Copenhagen' })).toEqual([]);
  });

  it('measures a coordinate stored as a number as well as a string', () => {
    const numeric = nearbyShowAt({ latitude: 55.6677, longitude: 12.5455 });
    expect(nearbyConcerts([numeric], { ...CPH, radiusKm: 30 })).toHaveLength(1);
  });

  it.each([[''], ['null'], ['abc'], [null], ['999']])('treats the stored coordinate %j as missing, not as a point', (bad) => {
    const [kept] = nearbyConcerts([nearbyShowAt({ latitude: bad, longitude: bad })], { ...CPH, radiusKm: 30, city: 'Copenhagen' });
    expect(kept).toMatchObject({ match: 'city_name', distance_km: null, latitude: null, longitude: null });
  });

  it('falls back to the city name only for a show with no coordinates, and marks it', () => {
    const [kept] = nearbyConcerts([nearbyShowAt({ latitude: null, longitude: null, city: 'KOPENHAGEN' }), nearbyShowAt({ id: 2, latitude: null, longitude: null, city: 'Copenhagen' })], { ...CPH, radiusKm: 30, city: 'copenhagen' });
    expect(kept.id).toBe(2);
    expect(kept.match).toBe('city_name');
  });

  it('does not match a show with no coordinates when no city was asked for', () => {
    expect(nearbyConcerts([nearbyShowAt({ latitude: null, longitude: null })], { ...CPH, radiusKm: 30 })).toEqual([]);
  });

  it('compares city names without accents or case', () => {
    const koln = nearbyShowAt({ latitude: null, longitude: null, city: 'Köln' });
    expect(nearbyConcerts([koln], { radiusKm: 30, city: 'koln' })).toHaveLength(1);
  });

  it('also reads the folded city row\'s name', () => {
    const folded = nearbyShowAt({ latitude: null, longitude: null, city: 'København', city_rel: { name: 'Copenhagen' } });
    expect(nearbyConcerts([folded], { radiusKm: 30, city: 'Copenhagen' })).toHaveLength(1);
  });

  it('asked by name alone, keeps a located show and leaves it unmeasured', () => {
    const [kept] = nearbyConcerts([nearbyShowAt()], { radiusKm: 30, city: 'Copenhagen' });
    expect(kept).toMatchObject({ match: 'city_name', distance_km: null });
    expect(kept.latitude).toBeCloseTo(55.6677);
  });
});

describe('nearbyConcertOut', () => {
  const concert = {
    ...nearbyShowAt(), name: 'Tour', festival: null, country: 'DK', concert_date: new Date('2026-11-14T19:00:00Z'), source: 'bandsintown',
    url: 'https://example.test/e', on_sale: true, sold_out: false, ticket_sale_start: null,
    latitude: 55.6677, longitude: 12.5455, distance_km: 1.1, match: 'distance',
    bands: [{ band_rel: { id: 9, name: 'Zebra' } }, { band_rel: { id: 4, name: 'Alpha' } }],
  };

  it('leaves concert_date as stored and names how to read it', () => {
    const out = nearbyConcertOut(concert, new Map([[4, 'MUST']]), new Date('2026-11-03T00:00:00Z'));
    expect(out).toMatchObject({
      concert_date: '2026-11-14T19:00:00.000Z', time_kind: 'wall_clock', festival: false, ticket_state: 'on_sale', url: 'https://example.test/e',
    });
  });

  it('lists the wishlist bands by name with their tier, null when not known', () => {
    const out = nearbyConcertOut(concert, new Map([[4, 'MUST']]));
    expect(out.bands).toEqual([{ id: 4, name: 'Alpha', tier: 'MUST' }, { id: 9, name: 'Zebra', tier: null }]);
  });

  it('reports a sold-out show as sold out', () => {
    expect(nearbyConcertOut({ ...concert, sold_out: true }, new Map()).ticket_state).toBe('sold_out');
  });
});
