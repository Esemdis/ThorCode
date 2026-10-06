import { describe, it, expect } from 'vitest';
import { festivalName, touringRows, groupFestivals } from './festivals.js';

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

  it('makes one festival of two names for it a couple of days apart', () => {
    // Songkick lists Nova Rock twice, once with "Festival" in the name.
    const at = { city: 'Nickelsdorf', country: 'AT', venue: 'Pannonia Fields II' };
    const entries = group([
      row({ id: 1, ...at, name: 'Nova Rock 2027', concert_date: new Date('2027-06-10T00:00:00Z'), latitude: '47.94', longitude: '17.07', bands: [act(1, 'I Prevail')] }),
      row({ id: 2, ...at, name: 'Nova Rock Festival 2027', concert_date: new Date('2027-06-12T00:00:00Z'), latitude: '47.95', longitude: '17.08',
        url: 'http://www.songkick.com/festivals/9-nova-rock/id/1-nova-rock-2027', bands: [act(1, 'I Prevail'), act(2, 'Lorna Shore')] }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'Nova Rock Festival 2027', first: '2027-06-10', last: '2027-06-12', acts: 2 });
  });

  it('keeps apart two festivals on one weekend, by name or by place', () => {
    const names = group([
      row({ id: 1, name: 'Hurricane Festival 2027', city: 'Scheessel', country: 'DE', concert_date: new Date('2027-06-18T00:00:00Z') }),
      row({ id: 2, name: 'Southside Festival 2027', city: 'Neuhausen Ob Eck', country: 'DE', concert_date: new Date('2027-06-18T00:00:00Z') }),
      row({ id: 3, name: 'Rock am Ring 2027', city: 'Nürburg', country: 'DE', concert_date: new Date('2027-06-04T00:00:00Z') }),
      row({ id: 4, name: 'Rock im Park 2027', city: 'Nürnberg', country: 'DE', concert_date: new Date('2027-06-04T00:00:00Z') }),
      // Same name, another town: a touring festival's other stop.
      row({ id: 5, name: 'Rock am Ring 2027', city: 'Mendig', country: 'DE', concert_date: new Date('2027-06-05T00:00:00Z'), latitude: '50.37', longitude: '7.28' }),
    ]).map((e) => e.name);

    expect(names).toHaveLength(5);
  });

  it('lists everyone else on the bill, in the order the fullest lineup gives them', () => {
    const [entry] = group([
      row({ id: 1, name: 'Nova Rock 2027', city: 'Nickelsdorf', country: 'AT', bands: [act(1, 'I Prevail'), act(5, 'Hot Milk')] }),
      row({ id: 2, name: 'Nova Rock Festival 2027', city: 'Nickelsdorf', country: 'AT', concert_date: new Date('2027-06-18T00:00:00Z'),
        metadata: JSON.stringify(['Linkin Park', 'I Prevail', 'Architects (UK)', 'Hot Milk']), bands: [act(3, 'Architects')] }),
    ], new Map([[1, 'LOVE']]));

    expect(entry.bands).toEqual([{ id: 1, name: 'I Prevail', tier: 'LOVE' }]);
    // A linked act goes by its band's own name, not the scraped spelling.
    expect(entry.lineup).toEqual(['Linkin Park', 'Architects', 'Hot Milk']);
    expect(entry.acts).toBe(4);
  });

  it('is followed by its Songkick festival page, and says where that page\'s tickets are', () => {
    const [entry] = group([
      row({ id: 1, name: 'Copenhell 2027', url: 'https://www.bandsintown.com/e/1', on_sale: true }),
      row({ id: 2, name: 'Copenhell 2027', url: 'http://www.songkick.com/festivals/5-copenhell/id/8-copenhell-2027',
        on_sale: false, ticket_sale_start: new Date('2099-10-09T00:00:00Z') }),
    ]);

    expect(entry).toMatchObject({ concert_id: 2, tickets: 'on_sale_soon', sale_date: '2099-10-09' });
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

describe('touringRows', () => {
  // Songkick files the Hollywood Undead EU/UK tour under /festivals/, one
  // series with a date in each town.
  const tour = (id, city) => row({
    id, city, name: 'Hollywood Undead: EU/UK 2027', bands: [act(1, 'Hollywood Undead')],
    url: `http://www.songkick.com/festivals/3808399-hollywood-undead-euuk/id/${id}-hollywood-undead-euuk-2027`,
  });

  it('takes a series with dates in several towns for a tour', () => {
    const touring = touringRows([tour(1, 'Prague'), tour(2, 'Warsaw')].map((r) => ({ ...r, name: 'EU/UK 2027' })));

    expect([...touring]).toEqual([1, 2]);
  });

  it('takes an event named after an act on its own bill for a tour, even with one date left', () => {
    expect([...touringRows([tour(1, 'Copenhagen')])]).toEqual([1]);
  });

  it('keeps a festival held in one place, whoever plays it', () => {
    const touring = touringRows([
      row({ id: 1, name: 'Raptor Festival 2027', city: 'Koenigsbrunn', bands: [act(2, 'ABBIE FALLS')],
        url: 'http://www.songkick.com/festivals/3632157-raptor/id/43412176-raptor-festival-2027' }),
      // Word by word: the band Hell is not what Hellfest is named after.
      row({ id: 2, name: 'Hellfest 2027', city: 'Clisson', country: 'FR', bands: [act(3, 'Hell')] }),
      // Next year's edition is the same series in the same town.
      row({ id: 3, name: 'Copenhell 2028', concert_date: new Date('2028-06-15T00:00:00Z'),
        url: 'http://www.songkick.com/festivals/5-copenhell/id/9-copenhell-2028' }),
      row({ id: 4, url: 'http://www.songkick.com/festivals/5-copenhell/id/8-copenhell-2027' }),
    ]);

    expect([...touring]).toEqual([]);
  });
});

