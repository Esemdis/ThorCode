import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installFakePrisma } from '../test/routeApp.js';

// Seeded before the modules are imported — see installFakePrisma for why this
// is a global rather than a vi.mock.
const prisma = installFakePrisma({
  concert: { findMany: vi.fn(), update: vi.fn() },
  concertBandReference: { findMany: vi.fn(), upsert: vi.fn() },
  band: { findMany: vi.fn() },
});

const { enrichConcertBands } = await import('./setlistEnrich.js');
const { backfillSetlists } = await import('./setlistBackfill.js');

const GOJIRA = 'mbid-gojira';
const setlistFor = (mbid, songs) => ({
  artist: { mbid },
  sets: { set: [{ song: songs.map((name) => ({ name })) }] },
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.concertBandReference.findMany.mockResolvedValue([]);
  prisma.band.findMany.mockImplementation(async ({ where }) =>
    where.MBID.in.map((MBID, i) => ({ id: 100 + i, MBID })));
});

describe('enrichConcertBands', () => {
  it('finds a band on the bill by its MBID when the venue name does not match setlist.fm', async () => {
    // Scraped "Tele2 Arena" vs setlist.fm's own spelling: the venue search is empty.
    const search = vi.fn(async (params) =>
      params.artistMbid === GOJIRA ? [setlistFor(GOJIRA, ['Stranded', 'Silvera'])] : []);
    prisma.concertBandReference.findMany.mockResolvedValue([{ band_rel: { MBID: GOJIRA } }]);

    const out = await enrichConcertBands(7, '12-09-2026', 'Tele2 Arena', 'Stockholm', { search, gapMs: 0 });

    expect(search).toHaveBeenCalledWith({ date: '12-09-2026', artistMbid: GOJIRA });
    expect(out).toEqual({ updated: 1 });
    expect(prisma.concertBandReference.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { concert_band: { concert: 7, band: 100 } },
      update: { setlist: { songs: [
        { name: 'Stranded', cover: null, tape: false },
        { name: 'Silvera', cover: null, tape: false },
      ] } },
    }));
  });

  it('does not look a band up again when the venue search already found its songs', async () => {
    const search = vi.fn(async () => [setlistFor(GOJIRA, ['Stranded'])]);
    prisma.concertBandReference.findMany.mockResolvedValue([{ band_rel: { MBID: GOJIRA } }]);

    await enrichConcertBands(7, '12-09-2026', 'Tele2 Arena', 'Stockholm', { search, gapMs: 0 });

    expect(search).toHaveBeenCalledTimes(1);
  });

  it('still tries each band when the venue search fails outright', async () => {
    const search = vi.fn(async (params) => {
      if (params.venueName) throw new Error('timeout');
      return [setlistFor(GOJIRA, ['Stranded'])];
    });
    prisma.concertBandReference.findMany.mockResolvedValue([{ band_rel: { MBID: GOJIRA } }]);

    const out = await enrichConcertBands(7, '12-09-2026', 'Tele2 Arena', 'Stockholm', { search, gapMs: 0 });

    expect(out).toEqual({ updated: 1 });
  });

  it('links a tracked band that played without overwriting anything when it has no songs', async () => {
    const search = vi.fn(async () => [{ artist: { mbid: GOJIRA }, sets: { set: [] } }]);

    const out = await enrichConcertBands(7, '12-09-2026', 'Tele2 Arena', 'Stockholm', { search, gapMs: 0 });

    expect(out).toEqual({ updated: 0 });
    expect(prisma.concertBandReference.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
  });
});

describe('backfillSetlists', () => {
  it('takes never-checked and least recently checked shows first, and stamps each one', async () => {
    prisma.concert.findMany.mockResolvedValue([
      { id: 1, concert_date: new Date('2026-09-12T19:00:00Z'), venue: 'Tele2 Arena', city: 'Stockholm' },
    ]);
    const enrich = vi.fn(async () => ({ updated: 1 }));

    const out = await backfillSetlists({ enrich, gapMs: 0 });

    const query = prisma.concert.findMany.mock.calls[0][0];
    expect(query.orderBy[0]).toEqual({ setlist_checked_at: { sort: 'asc', nulls: 'first' } });
    expect(query.where.bands.some.band_rel).toEqual({ MBID: { not: null } });
    expect(enrich).toHaveBeenCalledWith(1, '12-09-2026', 'Tele2 Arena', 'Stockholm');
    expect(prisma.concert.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { setlist_checked_at: expect.any(Date) } });
    expect(out).toEqual({ checked: 1, updated: 1 });
  });

  it('stamps a show even when nothing was found, so it moves to the back of the queue', async () => {
    prisma.concert.findMany.mockResolvedValue([
      { id: 2, concert_date: new Date('2026-06-01T20:00:00Z'), venue: 'Debaser', city: 'Stockholm' },
    ]);

    await backfillSetlists({ enrich: async () => ({ updated: 0 }), gapMs: 0 });

    expect(prisma.concert.update).toHaveBeenCalledWith({ where: { id: 2 }, data: { setlist_checked_at: expect.any(Date) } });
  });
});
