import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { bandMergeConflicts, bandMergeGaps, strongerBandTier, mergeBands } = require('./bandMerge.js');

describe('bandMergeConflicts', () => {
  it('names every id both bands hold with a different value', () => {
    const source = { MBID: 'aaa', spotify_id: 'sp1', ticketmaster_id: 'tm1' };
    const target = { MBID: 'bbb', spotify_id: 'sp1', ticketmaster_id: 'tm2' };
    expect(bandMergeConflicts(source, target)).toEqual([
      { field: 'MBID', source: 'aaa', target: 'bbb' },
      { field: 'ticketmaster_id', source: 'tm1', target: 'tm2' },
    ]);
  });

  it('sees no conflict where either side is null, because that is a gap to fill', () => {
    expect(bandMergeConflicts({ MBID: 'aaa', spotify_id: null }, { MBID: null, spotify_id: 'sp' })).toEqual([]);
  });

  it('ignores the URLs and the setlist, which are not identities', () => {
    expect(bandMergeConflicts({ songkick_url: 'a' }, { songkick_url: 'b' })).toEqual([]);
  });
});

describe('bandMergeGaps', () => {
  it("fills the survivor's empty ids, links and setlist from the band going away", () => {
    const at = new Date('2026-01-02T00:00:00Z');
    const source = {
      MBID: 'aaa', spotify_id: 'sp', ticketmaster_id: null,
      songkick_url: 'sk', bandsintown_url: 'bit', setlist: [{ song: 'x' }], setlist_updated_at: at,
    };
    const target = { MBID: null, spotify_id: 'mine', ticketmaster_id: null, songkick_url: null, bandsintown_url: 'own', setlist: null };
    expect(bandMergeGaps(source, target)).toEqual({
      MBID: 'aaa', songkick_url: 'sk', setlist: [{ song: 'x' }], setlist_updated_at: at,
    });
  });

  it('keeps everything the survivor already has, even when it differs', () => {
    expect(bandMergeGaps({ MBID: 'aaa', songkick_url: 'sk' }, { MBID: 'bbb', songkick_url: 'own' })).toEqual({});
  });

  it('takes the earlier created_at, so the survivor reads as old as the oldest row', () => {
    const early = new Date('2024-01-01T00:00:00Z');
    const late = new Date('2025-01-01T00:00:00Z');
    expect(bandMergeGaps({ created_at: early }, { created_at: late })).toEqual({ created_at: early });
    expect(bandMergeGaps({ created_at: late }, { created_at: early })).toEqual({});
    expect(bandMergeGaps({ created_at: early }, { created_at: null })).toEqual({ created_at: early });
    expect(bandMergeGaps({ created_at: null }, { created_at: late })).toEqual({});
  });
});

describe('strongerBandTier', () => {
  it('keeps the warmer of two tiers, so a merge never cools a follow', () => {
    expect(strongerBandTier('FOLLOW', 'LOVE')).toBe('LOVE');
    expect(strongerBandTier('LIKE', 'FOLLOW')).toBe('LIKE');
    expect(strongerBandTier('LOVE', 'LIKE')).toBe('LOVE');
  });
});

// A transaction client whose reads answer from the tables passed in and whose
// writes are recorded. Enough to see which rows mergeBands drops and which it
// moves; the integration test runs the same against Postgres.
function makeBandMergeTx({ bands, links = [], refs = [], missed = [], deliveries = [], subs = [], media = [] }) {
  const calls = [];
  const rec = (name, result) => vi.fn(async (arg) => { calls.push([name, arg]); return result; });
  const byBand = (rows, key) => (arg) => rows.filter((r) => r[key] === arg.where[key]);
  return {
    calls,
    $queryRaw: rec('lock', []),
    band: {
      findUnique: vi.fn(async ({ where }) => bands.find((b) => b.id === where.id) ?? null),
      delete: rec('band.delete', {}),
      update: rec('band.update', {}),
    },
    concertBandReference: {
      findMany: vi.fn(async (arg) => byBand(links, 'band')(arg)),
      update: rec('link.update', {}),
      deleteMany: rec('link.deleteMany', { count: 0 }),
      updateMany: rec('link.updateMany', { count: 1 }),
    },
    wishlistBandReference: {
      findMany: vi.fn(async (arg) => byBand(refs, 'band_id')(arg)),
      update: rec('ref.update', {}),
      deleteMany: rec('ref.deleteMany', { count: 0 }),
      updateMany: rec('ref.updateMany', { count: 1 }),
    },
    attendanceMissedBand: {
      findMany: vi.fn(async (arg) => byBand(missed, 'band_id')(arg)),
      deleteMany: rec('missed.deleteMany', { count: 0 }),
      updateMany: rec('missed.updateMany', { count: 1 }),
    },
    concertDelivery: {
      findMany: vi.fn(async (arg) => byBand(deliveries, 'band_id')(arg)),
      deleteMany: rec('delivery.deleteMany', { count: 0 }),
      updateMany: rec('delivery.updateMany', { count: 1 }),
    },
    notificationSubscription: {
      findMany: vi.fn(async (arg) => byBand(subs, 'band_id')(arg)),
      deleteMany: rec('sub.deleteMany', { count: 0 }),
      updateMany: rec('sub.updateMany', { count: 1 }),
    },
    concertMedia: {
      findMany: vi.fn(async (arg) => byBand(media, 'band_id')(arg)),
      updateMany: rec('media.updateMany', { count: media.length }),
    },
  };
}

const tho999Source = { id: 1, name: 'Opeth (SE)', MBID: null, spotify_id: 'sp-1', ticketmaster_id: null, songkick_url: 'sk', created_at: null };
const tho999Target = { id: 2, name: 'Opeth', MBID: null, spotify_id: null, ticketmaster_id: null, songkick_url: null, created_at: null };

describe('mergeBands', () => {
  it('locks both band rows before reading them, so a sync cannot link the doomed row mid-merge', async () => {
    const tx = makeBandMergeTx({ bands: [tho999Source, tho999Target] });
    await mergeBands(tx, 1, 2);
    expect(tx.calls[0][0]).toBe('lock');
  });

  it('answers missing without writing when either band is gone', async () => {
    const tx = makeBandMergeTx({ bands: [tho999Target] });
    expect(await mergeBands(tx, 1, 2)).toEqual({ status: 'missing', bandId: 1 });
    expect(tx.calls.map((c) => c[0])).toEqual(['lock']);
  });

  it('stops at conflicting ids and writes nothing unless forced', async () => {
    const tx = makeBandMergeTx({ bands: [{ ...tho999Source, MBID: 'm1' }, { ...tho999Target, MBID: 'm2' }] });
    expect(await mergeBands(tx, 1, 2)).toEqual({
      status: 'conflict', conflicts: [{ field: 'MBID', source: 'm1', target: 'm2' }],
    });
    expect(tx.calls.map((c) => c[0])).toEqual(['lock']);
  });

  it('merges anyway when forced, keeping the survivor\'s own id', async () => {
    const tx = makeBandMergeTx({ bands: [{ ...tho999Source, MBID: 'm1' }, { ...tho999Target, MBID: 'm2' }] });
    const out = await mergeBands(tx, 1, 2, { force: true });
    expect(out.status).toBe('merged');
    expect(out.overridden).toEqual([{ field: 'MBID', source: 'm1', target: 'm2' }]);
    const update = tx.calls.find((c) => c[0] === 'band.update');
    expect(update[1].data.MBID).toBeUndefined();
  });

  it('drops the source\'s link to a show the survivor is already on, carrying its setlist across', async () => {
    const tx = makeBandMergeTx({
      bands: [tho999Source, tho999Target],
      links: [
        { id: 10, band: 1, concert: 100, setlist: [{ song: 'Ghost of Perdition' }] },
        { id: 11, band: 1, concert: 101, setlist: null },
        { id: 20, band: 2, concert: 100, setlist: null },
      ],
    });
    const out = await mergeBands(tx, 1, 2);
    expect(tx.calls).toContainEqual(['link.update', { where: { id: 20 }, data: { setlist: [{ song: 'Ghost of Perdition' }] } }]);
    expect(tx.calls).toContainEqual(['link.deleteMany', { where: { id: { in: [10] } } }]);
    expect(tx.calls).toContainEqual(['link.updateMany', { where: { band: 1 }, data: { band: 2 } }]);
    expect(out.dropped.concerts).toBe(1);
  });

  it('keeps a pending alert from the dropped link, or the act the sync linked under the other name is never announced', async () => {
    const tx = makeBandMergeTx({
      bands: [tho999Source, tho999Target],
      links: [
        { id: 12, band: 1, concert: 102, setlist: null, notify_pending: true },
        { id: 22, band: 2, concert: 102, setlist: null, notify_pending: false },
      ],
    });
    await mergeBands(tx, 1, 2);
    expect(tx.calls).toContainEqual(['link.update', { where: { id: 22 }, data: { notify_pending: true } }]);
  });

  it('drops the source\'s wishlist entry where the survivor is already followed, keeping the warmer tier', async () => {
    const tx = makeBandMergeTx({
      bands: [tho999Source, tho999Target],
      refs: [
        { id: 30, band_id: 1, wishlist_id: 7, tier: 'LOVE' },
        { id: 31, band_id: 1, wishlist_id: 8, tier: 'FOLLOW' },
        { id: 40, band_id: 2, wishlist_id: 7, tier: 'FOLLOW' },
      ],
    });
    await mergeBands(tx, 1, 2);
    expect(tx.calls).toContainEqual(['ref.update', { where: { id: 40 }, data: { tier: 'LOVE' } }]);
    expect(tx.calls).toContainEqual(['ref.deleteMany', { where: { id: { in: [30] } } }]);
    expect(tx.calls).toContainEqual(['ref.updateMany', { where: { band_id: 1 }, data: { band_id: 2 } }]);
  });

  it('moves the rows that cascade on delete, which a merge that skipped them would lose silently', async () => {
    // AttendanceMissedBand, ConcertDelivery and NotificationSubscription all
    // cascade from Band. Deleting the source without moving them drops "missed
    // this act" marks and alert watches, and losing the delivery ledger
    // re-sends alerts people already had.
    const tx = makeBandMergeTx({
      bands: [tho999Source, tho999Target],
      missed: [{ attendance_id: 5, band_id: 1 }, { attendance_id: 6, band_id: 1 }, { attendance_id: 5, band_id: 2 }],
      deliveries: [
        { concert_id: 100, wishlist_id: 7, band_id: 1 },
        { concert_id: 101, wishlist_id: 7, band_id: 1 },
        { concert_id: 100, wishlist_id: 7, band_id: 2 },
      ],
      subs: [
        { id: 50, user_id: 'u1', band_id: 1, city_id: null, tour_query: null, venue_query: null },
        { id: 51, user_id: 'u1', band_id: 1, city_id: 3, tour_query: null, venue_query: null },
        { id: 60, user_id: 'u1', band_id: 2, city_id: null, tour_query: null, venue_query: null },
      ],
    });
    await mergeBands(tx, 1, 2);
    expect(tx.calls).toContainEqual(['missed.deleteMany', { where: { band_id: 1, attendance_id: { in: [5] } } }]);
    expect(tx.calls).toContainEqual(['missed.updateMany', { where: { band_id: 1 }, data: { band_id: 2 } }]);
    expect(tx.calls).toContainEqual(['delivery.deleteMany', { where: { band_id: 1, OR: [{ concert_id: 100, wishlist_id: 7 }] } }]);
    expect(tx.calls).toContainEqual(['delivery.updateMany', { where: { band_id: 1 }, data: { band_id: 2 } }]);
    expect(tx.calls).toContainEqual(['sub.deleteMany', { where: { id: { in: [50] } } }]);
    expect(tx.calls).toContainEqual(['sub.updateMany', { where: { band_id: 1 }, data: { band_id: 2 } }]);
  });

  // watchKey joined the fields with "|", which writes null and "" the same and
  // lets a "|" typed into a query shift the fields: a watch of the source's
  // that differs from the survivor's was dropped as a copy of it.
  it('keeps a watch that differs from the survivor\'s only by an empty query versus none', async () => {
    const tx = makeBandMergeTx({
      bands: [tho999Source, tho999Target],
      subs: [
        { id: 70, user_id: 'u1', band_id: 1, city_id: null, tour_query: '', venue_query: null },
        { id: 71, user_id: 'u1', band_id: 1, city_id: null, tour_query: 'a|b', venue_query: 'c' },
        { id: 80, user_id: 'u1', band_id: 2, city_id: null, tour_query: null, venue_query: null },
        { id: 81, user_id: 'u1', band_id: 2, city_id: null, tour_query: 'a', venue_query: 'b|c' },
      ],
    });
    await mergeBands(tx, 1, 2);
    expect(tx.calls.some(([name]) => name === 'sub.deleteMany')).toBe(false);
  });

  it('retags media onto the survivor and hands back the files whose sidecars need it', async () => {
    const tx = makeBandMergeTx({
      bands: [tho999Source, tho999Target],
      media: [{ band_id: 1, rel_path: 'u/show/a.jpg' }],
    });
    const out = await mergeBands(tx, 1, 2);
    expect(tx.calls).toContainEqual(['media.updateMany', { where: { band_id: 1 }, data: { band_id: 2 } }]);
    expect(out.retagPaths).toEqual(['u/show/a.jpg']);
    expect(out.survivor).toEqual({ id: 2, name: 'Opeth' });
  });

  it('deletes the source before filling the survivor, because the ids it hands over are unique', async () => {
    const tx = makeBandMergeTx({ bands: [tho999Source, tho999Target] });
    const out = await mergeBands(tx, 1, 2);
    const names = tx.calls.map((c) => c[0]);
    expect(names.indexOf('band.delete')).toBeLessThan(names.indexOf('band.update'));
    expect(tx.calls).toContainEqual(['band.update', { where: { id: 2 }, data: { spotify_id: 'sp-1', songkick_url: 'sk' } }]);
    expect(out.filled).toEqual(['spotify_id', 'songkick_url']);
  });

  it('moves every referencing row before deleting the source, or the Restrict keys refuse the delete', async () => {
    const tx = makeBandMergeTx({ bands: [tho999Source, tho999Target] });
    await mergeBands(tx, 1, 2);
    const names = tx.calls.map((c) => c[0]);
    const del = names.indexOf('band.delete');
    for (const moved of ['link.updateMany', 'ref.updateMany', 'missed.updateMany', 'delivery.updateMany', 'sub.updateMany', 'media.updateMany']) {
      expect(names.indexOf(moved)).toBeLessThan(del);
    }
  });
});
