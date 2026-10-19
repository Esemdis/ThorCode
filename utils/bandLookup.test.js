import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findBandByCanonicalName } = require('./bandLookup.js');

const dbWith = (bands) => ({ band: { findMany: vi.fn(async () => bands), findFirst: vi.fn(async () => null) } });

describe('findBandByCanonicalName', () => {
  it('matches across capitalisation, accents and a country suffix', async () => {
    const db = dbWith([{ id: 1, name: 'Café Tacvba' }, { id: 2, name: 'Architects' }]);

    expect(await findBandByCanonicalName(db, 'CAFE tacvba')).toMatchObject({ id: 1 });
    expect(await findBandByCanonicalName(db, 'architects (UK)')).toMatchObject({ id: 2 });
  });

  it('answers null for a band that is not stored, and does not match a longer name', async () => {
    const db = dbWith([{ id: 1, name: 'Nothing More' }]);

    expect(await findBandByCanonicalName(db, 'Nothing')).toBeNull();
  });

  it('reads oldest first and takes the first of two duplicates', async () => {
    const db = dbWith([{ id: 4, name: 'Gojira' }, { id: 9, name: 'GOJIRA' }]);

    expect(await findBandByCanonicalName(db, 'gojira')).toMatchObject({ id: 4 });
    expect(db.band.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { id: 'asc' } }));
  });

  it('looks a name with nothing to compare up exactly', async () => {
    const db = dbWith([]);
    db.band.findFirst.mockResolvedValue({ id: 7, name: '!!!' });

    expect(await findBandByCanonicalName(db, '!!!')).toMatchObject({ id: 7 });
    expect(db.band.findMany).not.toHaveBeenCalled();
  });
});
