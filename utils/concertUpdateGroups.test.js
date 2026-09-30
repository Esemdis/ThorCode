import { describe, it, expect } from 'vitest';
import { groupConcertsByBand } from './concertUpdateGroups.js';

const band = (id, name, tier = 1) => ({ id, name, tier });

// Minimal shape of what the recent-concerts query selects.
function concert(id, created_at, concert_date, bands, extra = {}) {
  return {
    id,
    name: null,
    city: 'Oslo',
    country: 'NO',
    venue: 'Rockefeller',
    concert_date: new Date(concert_date),
    url: null,
    festival: false,
    created_at: new Date(created_at),
    latitude: null,
    longitude: null,
    participating_bands: bands,
    ...extra,
  };
}

describe('groupConcertsByBand', () => {
  it('collapses a whole tour into a single group for that band', () => {
    const ghost = band(1, 'Ghost');
    const rows = [
      concert(10, '2026-01-03', '2026-03-12', [ghost]),
      concert(11, '2026-01-03', '2026-03-14', [ghost]),
      concert(12, '2026-01-03', '2026-04-30', [ghost]),
    ];

    const groups = groupConcertsByBand(rows);

    expect(groups).toHaveLength(1);
    expect(groups[0].band).toEqual(ghost);
    expect(groups[0].count).toBe(3);
  });

  it('reports the date range across the group, not the insertion order', () => {
    const ghost = band(1, 'Ghost');
    // Deliberately out of date order: the query sorts by created_at, not concert_date.
    const rows = [
      concert(10, '2026-01-03', '2026-04-30', [ghost]),
      concert(11, '2026-01-03', '2026-03-12', [ghost]),
    ];

    const [group] = groupConcertsByBand(rows);

    expect(group.first_date).toEqual(new Date('2026-03-12'));
    expect(group.last_date).toEqual(new Date('2026-04-30'));
  });

  it('lists each country once, ordered by how many shows are in it', () => {
    const ghost = band(1, 'Ghost');
    const rows = [
      concert(10, '2026-01-03', '2026-03-12', [ghost], { country: 'SE' }),
      concert(11, '2026-01-03', '2026-03-13', [ghost], { country: 'NO' }),
      concert(12, '2026-01-03', '2026-03-14', [ghost], { country: 'SE' }),
    ];

    expect(groupConcertsByBand(rows)[0].countries).toEqual(['SE', 'NO']);
  });

  it('puts the band with the most recently added concert first', () => {
    const ghost = band(1, 'Ghost');
    const opeth = band(2, 'Opeth');
    const rows = [
      concert(10, '2026-01-05', '2026-06-18', [opeth]),
      concert(11, '2026-01-03', '2026-03-12', [ghost]),
    ];

    expect(groupConcertsByBand(rows).map((g) => g.band.name)).toEqual(['Opeth', 'Ghost']);
  });

  it('is not reordered by group size, so a big tour cannot bury a newer announcement', () => {
    const ghost = band(1, 'Ghost');
    const opeth = band(2, 'Opeth');
    const rows = [
      concert(10, '2026-01-05', '2026-06-18', [opeth]),
      ...Array.from({ length: 20 }, (_, i) =>
        concert(100 + i, '2026-01-03', `2026-03-${String(i + 1).padStart(2, '0')}`, [ghost])),
    ];

    expect(groupConcertsByBand(rows)[0].band.name).toBe('Opeth');
  });

  it('stacks a festival with several wishlist bands into one group headed by all of them', () => {
    // It used to be one group per band, the same show repeated under each —
    // ten of yours on a bill was ten rows saying the same thing.
    const ghost = band(1, 'Ghost');
    const opeth = band(2, 'Opeth');
    const alcest = band(3, 'Alcest');
    const rows = [concert(10, '2026-01-03', '2026-06-18', [ghost, opeth, alcest], { festival: true })];

    const groups = groupConcertsByBand(rows);

    expect(groups).toHaveLength(1);
    expect(groups[0].bands).toEqual([ghost, opeth, alcest]);
    expect(groups[0].count).toBe(1);
  });

  it("keeps a band's own shows apart from the festival it shares with others", () => {
    const ghost = band(1, 'Ghost');
    const opeth = band(2, 'Opeth');
    const rows = [
      concert(10, '2026-01-03', '2026-03-12', [ghost]),
      concert(11, '2026-01-03', '2026-03-14', [ghost]),
      concert(12, '2026-01-03', '2026-06-18', [ghost, opeth], { festival: true }),
    ];

    const groups = groupConcertsByBand(rows);

    expect(groups.map((g) => g.bands.map((b) => b.name))).toEqual([['Ghost'], ['Ghost', 'Opeth']]);
    expect(groups.map((g) => g.count)).toEqual([2, 1]);
  });

  it('stacks a co-headline tour into one group whatever order each date lists the bands in', () => {
    const ghost = band(1, 'Ghost');
    const opeth = band(2, 'Opeth');
    const rows = [
      concert(10, '2026-01-03', '2026-03-12', [ghost, opeth]),
      concert(11, '2026-01-03', '2026-03-14', [opeth, ghost]),
    ];

    const groups = groupConcertsByBand(rows);

    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
  });

  it('still names one band for a client that only reads `band`', () => {
    const ghost = band(1, 'Ghost');
    const opeth = band(2, 'Opeth');
    const [group] = groupConcertsByBand([concert(10, '2026-01-03', '2026-06-18', [ghost, opeth])]);

    expect(group.band).toEqual(ghost);
  });

  it('keeps each group internally sorted by concert date', () => {
    const ghost = band(1, 'Ghost');
    const rows = [
      concert(10, '2026-01-03', '2026-04-30', [ghost]),
      concert(11, '2026-01-03', '2026-03-12', [ghost]),
    ];

    expect(groupConcertsByBand(rows)[0].concerts.map((c) => c.id)).toEqual([11, 10]);
  });

  it('keeps the rest of the lineup on each concert inside a group', () => {
    const ghost = band(1, 'Ghost');
    const opeth = band(2, 'Opeth');
    const rows = [concert(10, '2026-01-03', '2026-06-18', [ghost, opeth])];

    const [group] = groupConcertsByBand(rows);

    // Left whole even though the group's header names these bands: a client
    // that reads only `band` shows the rest of the lineup from here.
    expect(group.concerts[0].participating_bands).toEqual([ghost, opeth]);
  });

  it('ignores a concert that has no wishlist band on it', () => {
    expect(groupConcertsByBand([concert(10, '2026-01-03', '2026-03-12', [])])).toEqual([]);
  });

  it('caps the number of groups and the concerts inside each one', () => {
    const rows = Array.from({ length: 5 }, (_, b) =>
      Array.from({ length: 4 }, (_, i) =>
        concert(b * 100 + i, `2026-01-${String(5 - b).padStart(2, '0')}`, '2026-03-12', [band(b, `Band ${b}`)])),
    ).flat();

    const groups = groupConcertsByBand(rows, { maxGroups: 2, maxConcertsPerGroup: 3 });

    expect(groups).toHaveLength(2);
    expect(groups[0].concerts).toHaveLength(3);
    // The cap hides shows, so the count must still report the true total.
    expect(groups[0].count).toBe(4);
  });
});
