import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const { planVenueMerges, venueId } = createRequire(import.meta.url)('./venueMatch.js');

const venue = (id, name, city_id, latitude, longitude, concerts = 0) => ({ id, name, city_id, latitude, longitude, concerts });

describe('planVenueMerges', () => {
  it('folds a longer name for the same room into the busier row', () => {
    const rock = venue(1, 'Rockefeller', 10, null, null, 5);
    const hall = venue(2, 'Rockefeller Music Hall', 10, null, null, 1);
    expect(planVenueMerges([hall, rock])).toEqual([{ loser: hall, winner: rock, name: 1, km: null }]);
  });

  it('folds two names at one spot, and says how far apart they are', () => {
    const o2 = venue(1, 'The O2', 10, 51.5030, 0.0032, 2);
    const arena = venue(2, 'O2 Arena', 10, 51.5031, 0.0031, 1);
    const [merge] = planVenueMerges([o2, arena]);
    expect(merge).toMatchObject({ loser: arena, winner: o2 });
    expect(merge.km).toBeLessThan(0.05);
  });

  it('never folds across cities, and leaves distinct names 500 m apart alone', () => {
    const stockholm = venue(1, 'Debaser', 10, 59.3190, 18.0290, 3);
    const malmo = venue(2, 'Debaser', 11, 55.5930, 13.0110, 1);
    const fasching = venue(3, 'Fasching', 10, 59.3340, 18.0560, 1);
    const nalen = venue(4, 'Nalen', 10, 59.3360, 18.0640, 1);
    expect(planVenueMerges([stockholm, malmo, fasching, nalen])).toEqual([]);
  });

  it('merges into a row that stays, never into one that goes', () => {
    // b is within reach of a and c, c only of b: c must stay rather than chain.
    const a = venue(1, 'Alpha Hall', 10, 59.0, 10.0, 3);
    const b = venue(2, 'Beta Room', 10, 59.0015, 10.0, 2);
    const c = venue(3, 'Gamma Club', 10, 59.0030, 10.0, 1);
    expect(planVenueMerges([a, b, c]).map((m) => [m.loser.id, m.winner.id])).toEqual([[2, 1]]);
  });
});

describe('venueId', () => {
  it('asks nothing without a name or a city to file it under', async () => {
    const db = { $queryRaw: () => { throw new Error('queried'); } };
    expect(await venueId(db, { name: '  ', cityId: 1 })).toBeNull();
    expect(await venueId(db, { name: 'Annexet', cityId: null })).toBeNull();
  });

  it('sends a position only as a pair', async () => {
    const calls = [];
    const db = { $queryRaw: async (_sql, ...values) => { calls.push(values); return [{ id: 4 }]; } };
    expect(await venueId(db, { name: ' Annexet ', cityId: 7, latitude: '59.29', longitude: 'N/A' })).toBe(4);
    expect(calls[0]).toEqual(['Annexet', ' Annexet ', 7, null, null]);
  });
});
