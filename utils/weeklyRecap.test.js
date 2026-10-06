import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { installFakePrisma } from '../test/routeApp.js';

const prisma = installFakePrisma({
  concert: { findMany: vi.fn() },
  wishlist: { findMany: vi.fn() },
});

// This file's own copies — it is CommonJS and loads them through Node's
// require, which an ESM import would not share.
const require = createRequire(import.meta.url);
const axios = require('axios');
const { weekBounds, summarizeWeek, weeklyRecap, sendWeeklyRecaps } = require('./weeklyRecap.js');

const iso = (b) => [b.start.toISOString(), b.end.toISOString()];

beforeEach(() => {
  vi.restoreAllMocks();
  prisma.concert.findMany.mockReset().mockResolvedValue([]);
  prisma.wishlist.findMany.mockReset().mockResolvedValue([]);
});

describe('weekBounds', () => {
  it("runs Monday to Monday on the viewer's clock, not the server's", () => {
    // Sunday 4 October 2026, midday. Stockholm is two hours ahead of UTC.
    const week = weekBounds(new Date('2026-10-04T12:00:00Z'), 'Europe/Stockholm');

    expect(iso(week)).toEqual(['2026-09-27T22:00:00.000Z', '2026-10-04T22:00:00.000Z']);
    expect(week).toMatchObject({ first_day: '2026-09-28', last_day: '2026-10-04', year: 2026, week: 40 });
  });

  it('counts half past midnight on a Monday into the new week', () => {
    // Still Sunday in UTC. Read on the server's clock, a show added now
    // landed in the week before.
    const week = weekBounds(new Date('2026-10-04T22:30:00Z'), 'Europe/Stockholm');

    expect(week.first_day).toBe('2026-10-05');
    expect(week.week).toBe(41);
  });

  it('steps back whole weeks', () => {
    const week = weekBounds(new Date('2026-10-04T12:00:00Z'), 'Europe/Stockholm', 1);

    expect(iso(week)).toEqual(['2026-09-20T22:00:00.000Z', '2026-09-27T22:00:00.000Z']);
    expect(week.week).toBe(39);
  });

  it('keeps a week that the clocks change in to its two midnights', () => {
    // Summer time ends on Sunday 25 October, so that week is 169 hours long
    // and starts and ends at different offsets from UTC.
    const autumn = weekBounds(new Date('2026-10-21T12:00:00Z'), 'Europe/Stockholm');
    expect(iso(autumn)).toEqual(['2026-10-18T22:00:00.000Z', '2026-10-25T23:00:00.000Z']);

    const spring = weekBounds(new Date('2026-03-25T12:00:00Z'), 'Europe/Stockholm');
    expect(iso(spring)).toEqual(['2026-03-22T23:00:00.000Z', '2026-03-29T22:00:00.000Z']);
  });

  it('numbers weeks as ISO 8601 does, across the turn of the year', () => {
    // 2026 starts on a Thursday, so it has a week 53, and that week holds
    // New Year's Day 2027.
    const week = weekBounds(new Date('2027-01-01T12:00:00Z'), 'UTC');

    expect(week).toMatchObject({ first_day: '2026-12-28', last_day: '2027-01-03', year: 2026, week: 53 });
  });
});

describe('summarizeWeek', () => {
  const ghost = { id: 1, name: 'Ghost', tier: 'LOVE' };
  const opeth = { id: 2, name: 'Opeth', tier: 'LIKE' };
  const tool = { id: 3, name: 'Tool', tier: 'FOLLOW' };
  let next = 0;
  const show = (city, country, concert_date, bands, extra = {}) => ({
    id: ++next, city, country, venue: `${city} Arena`, name: null,
    concert_date: concert_date && new Date(concert_date), participating_bands: bands, ...extra,
  });

  it('counts a festival once in its town, and once for each of your bands on it', () => {
    const recap = summarizeWeek([
      show('Sölvesborg', 'SE', '2027-06-05', [tool, ghost, opeth], { name: 'Sweden Rock 2027', festival: true, url: 'https://www.songkick.com/festivals/1-sweden-rock' }),
      show('Stockholm', 'SE', '2027-03-12', [ghost]),
      show('Stockholm', 'SE', '2027-03-13', [ghost]),
      show('Berlin', 'DE', '2027-03-20', [opeth]),
    ]);

    expect(recap.total).toBe(4);
    expect(recap.country_count).toBe(2);
    expect(recap.cities.map((c) => [c.city, c.country, c.count])).toEqual([
      ['Stockholm', 'SE', 2], ['Berlin', 'DE', 1], ['Sölvesborg', 'SE', 1],
    ]);
    expect(recap.cities[2].concerts).toEqual([{
      id: expect.any(Number), concert_date: new Date('2027-06-05'), name: 'Sweden Rock 2027', venue: 'Sölvesborg Arena',
      festival: true, url: 'https://www.songkick.com/festivals/1-sweden-rock', bands: [ghost, opeth, tool],
    }]);
    expect(recap.bands.map((b) => [b.name, b.count, b.tier])).toEqual([
      ['Ghost', 3, 'LOVE'], ['Opeth', 2, 'LIKE'], ['Tool', 1, 'FOLLOW'],
    ]);
  });

  it("lists a city's shows soonest first, with those not dated yet last", () => {
    const recap = summarizeWeek([
      show('Stockholm', 'SE', null, [ghost]),
      show('Stockholm', 'SE', '2027-05-01', [ghost]),
      show('Stockholm', 'SE', '2027-03-01', [ghost]),
    ]);

    expect(recap.cities[0].concerts.map((c) => c.concert_date)).toEqual([
      new Date('2027-03-01'), new Date('2027-05-01'), null,
    ]);
  });

  it('keeps two cities of one name in different countries apart', () => {
    const recap = summarizeWeek([
      show('London', 'GB', '2027-04-01', [ghost]),
      show('London', 'CA', '2027-04-02', [ghost]),
    ]);

    expect(recap.cities.map((c) => c.country).sort()).toEqual(['CA', 'GB']);
  });

  it('files shows with no city under one Unknown', () => {
    const recap = summarizeWeek([
      show('', '', '2027-04-01', [ghost]),
      show(null, null, '2027-04-02', [ghost]),
    ]);

    expect(recap.cities.map((c) => [c.city, c.country, c.count])).toEqual([[null, null, 2]]);
    expect(recap.country_count).toBe(0);
  });
});

describe('weeklyRecap', () => {
  const row = (id, city, country, concert_date, created_at, bands = [{ band_rel: { id: 1, name: 'Ghost' } }]) => ({
    id, city, country, bands,
    concert_date: concert_date && new Date(concert_date),
    created_at: new Date(created_at),
  });
  const NOW = new Date('2026-10-04T12:00:00Z');

  it("asks only for this week's shows by the wishlist's bands, leaving setlist.fm's out", async () => {
    await weeklyRecap([{ band_id: 1, tier: 'LOVE' }, { band_id: 2, tier: 'LIKE' }], { now: NOW, timeZone: 'Europe/Stockholm' });

    const { where, select } = prisma.concert.findMany.mock.calls[0][0];
    expect(where.created_at).toEqual({ gte: new Date('2026-09-27T22:00:00Z'), lt: new Date('2026-10-04T22:00:00Z') });
    expect(where.bands).toEqual({ some: { band: { in: [1, 2] } } });
    expect(where.OR).toEqual([{ source: null }, { source: { not: 'setlistfm' } }]);
    expect(select.bands.where).toEqual({ band: { in: [1, 2] } });
  });

  it('leaves out a show that had already happened when it was added', async () => {
    prisma.concert.findMany.mockResolvedValue([
      row(1, 'Stockholm', 'SE', '2027-03-12', '2026-10-01T10:00:00Z'),
      // Brought in from someone's history: created this week, played in 2019.
      row(2, 'Linköping', 'SE', '2019-05-01', '2026-10-01T10:00:00Z'),
      // Added on the day it is played, which is still news.
      row(3, 'Oslo', 'NO', '2026-10-02T00:00:00Z', '2026-10-02T15:00:00Z'),
      // Not dated yet.
      row(4, 'Copenhagen', 'DK', null, '2026-10-03T10:00:00Z'),
    ]);

    const recap = await weeklyRecap([{ band_id: 1, tier: 'LOVE' }], { now: NOW, timeZone: 'Europe/Stockholm' });

    expect(recap.total).toBe(3);
    expect(recap.cities.map((c) => c.city).sort()).toEqual(['Copenhagen', 'Oslo', 'Stockholm']);
    expect(recap.bands).toEqual([{ id: 1, name: 'Ghost', tier: 'LOVE', count: 3 }]);
    expect(recap).toMatchObject({ week: 40, first_day: '2026-09-28', time_zone: 'Europe/Stockholm' });
  });

  it('does not ask at all for a wishlist with no bands', async () => {
    const recap = await weeklyRecap([], { now: NOW, timeZone: 'UTC' });

    expect(prisma.concert.findMany).not.toHaveBeenCalled();
    expect(recap.total).toBe(0);
  });
});

describe('sendWeeklyRecaps', () => {
  const wishlist = (id, settings, webhook = `https://discord.example/${id}`) => ({
    id, discord_webhook: webhook, user_rel: { settings }, bands: [{ band_id: 1, tier: 'LOVE' }],
  });
  const ADDED = [{
    id: 1, city: 'Stockholm', country: 'SE', concert_date: new Date('2027-03-12'), created_at: new Date('2026-09-30T10:00:00Z'),
    bands: [{ band_rel: { id: 1, name: 'Ghost' } }],
  }];
  // Monday 5 October, 09:00 UTC: the cron's default hour.
  const MONDAY = new Date('2026-10-05T09:00:00Z');

  it('posts last week to those who turned it on, and to nobody else', async () => {
    prisma.wishlist.findMany.mockResolvedValue([
      wishlist(1, { weeklyRecap: true, timeZone: 'Europe/Stockholm' }),
      wishlist(2, { weeklyRecap: false }),
      wishlist(3, null),
    ]);
    prisma.concert.findMany.mockResolvedValue(ADDED);
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 204 });

    const result = await sendWeeklyRecaps(MONDAY);

    expect(result).toEqual({ sent: 1, failed: 0, quiet: 0 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('https://discord.example/1');
    expect(post.mock.calls[0][1].embeds[0].title).toBe('Week 40: 1 new concert');
    // The week that ended at midnight on the owner's clock.
    expect(prisma.concert.findMany.mock.calls[0][0].where.created_at)
      .toEqual({ gte: new Date('2026-09-27T22:00:00Z'), lt: new Date('2026-10-04T22:00:00Z') });
  });

  it('only reads wishlists with a webhook', async () => {
    await sendWeeklyRecaps(MONDAY);

    expect(prisma.wishlist.findMany.mock.calls[0][0].where).toEqual({ discord_webhook: { not: null } });
  });

  it('stays quiet about a week with nothing in it', async () => {
    prisma.wishlist.findMany.mockResolvedValue([wishlist(1, { weeklyRecap: true, timeZone: 'Europe/Stockholm' })]);
    const post = vi.spyOn(axios, 'post');

    const result = await sendWeeklyRecaps(MONDAY);

    expect(result).toEqual({ sent: 0, failed: 0, quiet: 1 });
    expect(post).not.toHaveBeenCalled();
  });

  it('reads a zone it does not know as UTC rather than giving up', async () => {
    prisma.wishlist.findMany.mockResolvedValue([wishlist(1, { weeklyRecap: true, timeZone: 'Mars/Olympus_Mons' })]);
    prisma.concert.findMany.mockResolvedValue(ADDED);
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 204 });

    await sendWeeklyRecaps(MONDAY);

    expect(prisma.concert.findMany.mock.calls[0][0].where.created_at)
      .toEqual({ gte: new Date('2026-09-28T00:00:00Z'), lt: new Date('2026-10-05T00:00:00Z') });
  });

  it('carries on past a webhook Discord refuses', async () => {
    prisma.wishlist.findMany.mockResolvedValue([
      wishlist(1, { weeklyRecap: true }),
      wishlist(2, { weeklyRecap: true }),
    ]);
    prisma.concert.findMany.mockResolvedValue(ADDED);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(axios, 'post')
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { response: { status: 404 } }))
      .mockResolvedValueOnce({ status: 204 });

    const result = await sendWeeklyRecaps(MONDAY);

    expect(result).toEqual({ sent: 1, failed: 1, quiet: 0 });
  });
});
