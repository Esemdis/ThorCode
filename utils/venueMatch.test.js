import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const { venueId } = createRequire(import.meta.url)('./venueMatch.js');

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
