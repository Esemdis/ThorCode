import { describe, it, expect } from 'vitest';
import { festivalName, groupFestivals } from './festivals.js';

const act = (id, name) => ({ band_rel: { id, name } });
const row = (over = {}) => ({
  id: 1, name: 'Copenhell 2027', venue: 'Refshaleøen', city: 'Copenhagen', country: 'DK',
  concert_date: new Date('2027-06-17T00:00:00Z'), url: null, metadata: null, bands: [], ...over,
});
const group = (rows, tiers = new Map(), watched) => groupFestivals(rows, { tiers, watched });

describe('festivalName', () => {
  it('reads the festival from a Bandsintown act page', () => {
    expect(festivalName(row({ name: 'Motionless In White @ Copenhell' }))).toEqual({ name: 'Copenhell', proper: false });
  });

  it('takes the grounds for a page named after an act on its own bill', () => {
    expect(festivalName(row({ name: 'Gojira', venue: 'Copenhell', bands: [act(2, 'Gojira')] })))
      .toEqual({ name: 'Copenhell', proper: false });
  });

  it('keeps a festival\'s own name', () => {
    expect(festivalName(row())).toEqual({ name: 'Copenhell 2027', proper: true });
  });
});

describe('groupFestivals', () => {
  it('makes one entry of a festival listed per act and by Songkick, under its proper name', () => {
    const [entry, ...rest] = group([
      row({ id: 1, name: 'Motionless In White @ Copenhell', venue: 'Copenhell', concert_date: new Date('2027-06-18T00:00:00Z'), bands: [act(1, 'Motionless In White')] }),
      row({ id: 2, name: 'Copenhell 2027', url: 'http://www.songkick.com/festivals/1-copenhell/id/2-copenhell-2027', bands: [act(2, 'Gojira')] }),
    ]);

    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      name: 'Copenhell 2027', first: '2027-06-17', last: '2027-06-18', city: 'Copenhagen', country: 'DK', acts: 2,
      url: 'http://www.songkick.com/festivals/1-copenhell/id/2-copenhell-2027',
    });
  });

  it('keeps next year\'s edition and a namesake abroad apart', () => {
    const entries = group([
      row({ id: 1 }),
      row({ id: 2, name: 'Copenhell 2028', concert_date: new Date('2028-06-15T00:00:00Z') }),
      row({ id: 3, country: 'SE', city: 'Stockholm' }),
    ]);

    expect(entries).toHaveLength(3);
  });

  it('counts every act once, linked or only named in the lineup', () => {
    const [entry] = group([
      row({ id: 1, bands: [act(1, 'Opeth')], metadata: JSON.stringify(['Opeth', 'Gojira', 'Architects (UK)']) }),
      row({ id: 2, name: 'Architects @ Copenhell', bands: [act(3, 'Architects')] }),
    ]);

    expect(entry.acts).toBe(3);
  });

  it('marks your bands with their tier, and leaves everyone else out of them', () => {
    const [entry] = group([row({ bands: [act(1, 'Opeth'), act(2, 'Gojira')] })], new Map([[2, 'LOVE']]));

    expect(entry.bands).toEqual([{ id: 2, name: 'Gojira', tier: 'LOVE' }]);
  });

  it('says when one of your festival watches names it', () => {
    const [watchedEntry, other] = group(
      [row({ id: 1 }), row({ id: 2, name: 'Roskilde Festival 2027', concert_date: new Date('2027-07-01T00:00:00Z') })],
      new Map(),
      (c) => /copenhell/i.test(c.name),
    );

    expect([watchedEntry.watched, other.watched]).toEqual([true, false]);
  });

  it('lists the soonest first, and one with no date yet last', () => {
    const names = group([
      row({ id: 1, name: 'Roskilde Festival 2027', concert_date: new Date('2027-07-01T00:00:00Z') }),
      row({ id: 2, name: 'Undated Fest', concert_date: null }),
      row({ id: 3 }),
    ]).map((e) => e.name);

    expect(names).toEqual(['Copenhell 2027', 'Roskilde Festival 2027', 'Undated Fest']);
  });
});
