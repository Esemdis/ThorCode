import { describe, it, expect, vi } from 'vitest';
import { loadBulkCandidates, mergeWindows } from './bulkCandidates.js';
import { checkDuplicateConcert } from './concertDedup.js';

const DAY = 24 * 60 * 60 * 1000;

const tho968Row = (over = {}) => ({
  id: 1, event_id: null, name: null, venue: 'Annexet', city: 'Stockholm', country: 'SE',
  latitude: null, longitude: null, concert_date: new Date('2027-05-10T19:00:00Z'), festival: false,
  source: null, metadata: null, url: null, on_sale: false, sold_out: false, ticket_sale_start: null,
  price_min: null, price_max: null, price_currency: null, notify_pending: false, sources: [],
  bands: [{ band: 1, band_rel: { name: 'Gojira' } }],
  ...over,
});
const tho968Tx = (rows = []) => ({ concert: { findMany: vi.fn(async () => rows) } });
const tho968Show = (date, over = {}) => ({ country: 'SE', city: 'Stockholm', venue: 'Annexet', concert_date: date, ...over });

describe('loadBulkCandidates', () => {
  it('reads the candidates for a whole batch in one query', async () => {
    const tx = tho968Tx([]);

    await loadBulkCandidates(tx, [
      tho968Show('2027-05-10T19:00:00Z'), tho968Show('2027-05-13T19:00:00Z'), tho968Show('2027-11-01T19:00:00Z'),
    ]);

    expect(tx.concert.findMany).toHaveBeenCalledTimes(1);
    // Two windows, not one span from May to November: overlapping nights share
    // a window, and a tour months apart does not load every show in between.
    expect(tx.concert.findMany.mock.calls[0][0].where.OR).toEqual([
      { concert_date: { gte: new Date('2027-05-03T00:00:00Z'), lte: new Date('2027-05-20T00:00:00Z') } },
      { concert_date: { gte: new Date('2027-10-25T00:00:00Z'), lte: new Date('2027-11-08T00:00:00Z') } },
    ]);
  });

  it('reads nothing for a batch with no dated show', async () => {
    const tx = tho968Tx([]);

    const store = await loadBulkCandidates(tx, [tho968Show(null), tho968Show('not a date')]);

    expect(tx.concert.findMany).not.toHaveBeenCalled();
    expect(store.forShow(tho968Show('2027-05-10T19:00:00Z'))).toEqual([]);
  });

  it('gives each show only the rows in its own window, with the bounds its own read had', async () => {
    // detectFestivalCluster has no date filter, so a row from another show's
    // window would count towards this one's festival.
    const store = await loadBulkCandidates(tho968Tx([
      tho968Row({ id: 1, concert_date: new Date('2027-05-03T00:00:00Z') }), // day - 7, the lower bound
      tho968Row({ id: 2, concert_date: new Date('2027-05-17T00:00:00Z') }), // day + 7 at midnight, the upper bound
      tho968Row({ id: 3, concert_date: new Date('2027-05-17T19:00:00Z') }), // past it: lte is midnight
      tho968Row({ id: 4, concert_date: new Date('2027-05-18T19:00:00Z') }), // eight days away
      tho968Row({ id: 5, concert_date: null }),
    ]), [tho968Show('2027-05-10T19:00:00Z'), tho968Show('2027-05-14T19:00:00Z')]);

    expect(store.forShow(tho968Show('2027-05-10T21:00:00Z')).map((r) => r.id)).toEqual([1, 2]);
    expect(store.forShow(tho968Show(null))).toEqual([]);
  });

  it('shows a staged insert and merge to later shows only once committed', async () => {
    const store = await loadBulkCandidates(tho968Tx([tho968Row({ id: 1 })]), [tho968Show('2027-05-10T19:00:00Z')], {
      bandName: (id) => ({ 1: 'Gojira', 2: 'Opeth' })[id],
    });
    const show = tho968Show('2027-05-10T19:00:00Z');
    const stage = store.stage();
    stage.add(tho968Row({ id: 9, venue: 'Nalen', bands: undefined, created_at: new Date() }), [2, 2]);
    stage.merge(1, { name: 'Gojira live', venue_id: 31, festival: true });
    stage.link(1, [1, 2]);

    expect(store.forShow(show).map((r) => r.id)).toEqual([1]);
    store.commit(stage);

    const [one, nine] = store.forShow(show);
    expect(one).toMatchObject({ id: 1, name: 'Gojira live', festival: true });
    // Only what the candidate read selects: the row reads as a loaded one.
    expect(one).not.toHaveProperty('venue_id');
    expect(one.bands).toEqual([{ band: 1, band_rel: { name: 'Gojira' } }, { band: 2, band_rel: { name: 'Opeth' } }]);
    expect(nine).toMatchObject({ id: 9, venue: 'Nalen', bands: [{ band: 2, band_rel: { name: 'Opeth' } }] });
    expect(nine).not.toHaveProperty('created_at');
  });

  it('forgets a stage that was never committed, as a show rolled back to its savepoint', async () => {
    const store = await loadBulkCandidates(tho968Tx([tho968Row({ id: 1 })]), [tho968Show('2027-05-10T19:00:00Z')]);
    const rolledBack = store.stage();
    rolledBack.add(tho968Row({ id: 9 }));
    rolledBack.markFestival([1]);

    store.commit(store.stage());

    expect(store.forShow(tho968Show('2027-05-10T19:00:00Z'))).toEqual([tho968Row({ id: 1 })]);
  });

  it('finds a row an earlier show moved where it went, and leaves a held copy as it was read', async () => {
    const store = await loadBulkCandidates(tho968Tx([tho968Row({ id: 1 })]), [
      tho968Show('2027-05-10T19:00:00Z'), tho968Show('2027-05-30T19:00:00Z'),
    ]);
    const [held] = store.forShow(tho968Show('2027-05-10T19:00:00Z'));
    const stage = store.stage();
    stage.merge(1, { concert_date: new Date('2027-05-30T19:00:00Z') });
    store.commit(stage);

    expect(store.forShow(tho968Show('2027-05-10T19:00:00Z'))).toEqual([]);
    expect(store.forShow(tho968Show('2027-05-30T19:00:00Z')).map((r) => r.id)).toEqual([1]);
    // ingest.js reports the matched row's name and bill after the check, so a
    // commit must replace rows rather than change them under it.
    expect(held.concert_date).toEqual(new Date('2027-05-10T19:00:00Z'));
  });

  it('says whether a date is inside what it loaded', async () => {
    const store = await loadBulkCandidates(tho968Tx([]), [tho968Show('2027-05-10T19:00:00Z')]);

    expect(store.covers(new Date('2027-05-17T00:00:00Z'))).toBe(true);
    expect(store.covers(new Date('2027-05-17T00:00:01Z'))).toBe(false);
    expect(store.covers(null)).toBe(false);
  });
});

describe('mergeWindows', () => {
  it('joins windows that touch or overlap, in date order', () => {
    expect(mergeWindows([[10 * DAY, 20 * DAY], [0, 5 * DAY], [5 * DAY, 8 * DAY], [19 * DAY, 30 * DAY]]))
      .toEqual([[0, 8 * DAY], [10 * DAY, 30 * DAY]]);
  });
});

describe('checkDuplicateConcert given the rows already read (THO-968)', () => {
  const tho968DedupTx = () => ({
    concert: { findMany: vi.fn(async () => []), update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({})) },
    concertBandReference: { findMany: vi.fn(async () => [{ band: 1 }]), createMany: vi.fn(async () => ({})) },
  });

  it('matches against them without a read of its own', async () => {
    const tx = tho968DedupTx();

    const { isDuplicate, existingConcert } = await checkDuplicateConcert({
      concert: tho968Show('2027-05-10T21:00:00Z'), bandIds: [1], tx, candidates: [tho968Row({ id: 4 })],
    });

    expect(tx.concert.findMany).not.toHaveBeenCalled();
    expect(isDuplicate).toBe(true);
    expect(existingConcert.id).toBe(4);
  });

  it('hands back the rows it flagged as a festival, so the caller can mirror the write', async () => {
    const tx = tho968DedupTx();
    const otherDay = tho968Row({
      id: 4, name: 'Opeth @ Copenhell Festival', venue: 'Refshaleøen', city: 'Copenhagen', country: 'DK',
      concert_date: new Date('2027-06-18T00:00:00Z'), bands: [{ band: 2, band_rel: { name: 'Opeth' } }],
    });

    const { upgraded } = await checkDuplicateConcert({
      concert: tho968Show('2027-06-17T00:00:00Z', {
        name: 'Gojira @ Copenhell Festival', venue: 'Refshaleøen', city: 'Copenhagen', country: 'DK',
      }),
      bandIds: [1], bandNames: ['Gojira'], tx, candidates: [otherDay],
    });

    expect(upgraded).toEqual([4]);
    expect(tx.concert.updateMany).toHaveBeenCalledWith({ where: { id: { in: [4] } }, data: { festival: true } });
  });
});
