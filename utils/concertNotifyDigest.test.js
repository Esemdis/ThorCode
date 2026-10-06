import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { installFakePrisma } from '../test/routeApp.js';

const prisma = installFakePrisma({
  notificationDigestRun: {
    findFirst: vi.fn(async () => ({ id: 1, last_run_at: new Date('2026-09-25T08:00:00Z') })),
    create: vi.fn(),
    update: vi.fn(async () => ({})),
  },
  concertBandReference: { findMany: vi.fn() },
  notificationSubscription: { findMany: vi.fn() },
  wishlist: { findMany: vi.fn(async () => []) },
});

// This file's own copies — it is CommonJS and loads them through Node's
// require, which an ESM import would not share.
const require = createRequire(import.meta.url);
const mail = require('./mail.js');
const { runNotificationDigest } = require('./concertNotifyDigest.js');

const OPETH = { id: 9, name: 'Opeth' };
const GOJIRA = { id: 2, name: 'Gojira' };
// Created inside the window the run reads (it last ran 2026-09-25 08:00).
const concert = (id, over = {}) => ({
  id, name: null, venue: 'Debaser', city: 'Stockholm', country: 'SE', city_id: 12,
  concert_date: new Date('2026-11-02T19:00:00Z'), url: null, created_at: new Date('2026-09-25T09:00:00Z'),
  bands: [{ band_rel: OPETH }], ...over,
});
// One act put on a show's bill, as the digest reads it.
const linked = (show, band = show.bands[0].band_rel) => ({ band_rel: band, concert_rel: show });
const subscriber = (id, over = {}) => ({
  id, user_id: `user-${id}`, band_id: 9, city_id: null, tour_query: null, venue_query: null,
  user_rel: { id: `user-${id}`, email: `u${id}@example.test` }, ...over,
});

beforeEach(() => {
  prisma.concertBandReference.findMany.mockResolvedValue([linked(concert(100))]);
  prisma.notificationSubscription.findMany.mockResolvedValue([subscriber(1), subscriber(2)]);
});

describe('runNotificationDigest', () => {
  it('keeps the window when no digest could be sent at all', async () => {
    // A bad key or an email outage used to move the window on regardless,
    // and every concert in it was never mailed to anyone.
    vi.spyOn(mail, 'sendDigestEmail').mockRejectedValue(new Error('Email service error: invalid key'));

    const result = await runNotificationDigest();

    expect(result).toMatchObject({ sent: 0, failed: 2 });
    expect(prisma.notificationDigestRun.update).not.toHaveBeenCalled();
  });

  it('moves the window on once any digest went out', async () => {
    vi.spyOn(mail, 'sendDigestEmail')
      .mockResolvedValueOnce({ data: { id: 'a' } })
      .mockRejectedValueOnce(new Error('rate limited'));

    const result = await runNotificationDigest();

    expect(result).toMatchObject({ sent: 1, failed: 1 });
    expect(prisma.notificationDigestRun.update).toHaveBeenCalledTimes(1);
  });

  it('mails only shows still to come, not a past one imported today', async () => {
    // A show added from setlist.fm history is created today with a date years
    // back. Read by created_at alone, it went out as a new concert.
    vi.spyOn(mail, 'sendDigestEmail').mockResolvedValue({ data: { id: 'a' } });

    await runNotificationDigest();

    const { where } = prisma.concertBandReference.findMany.mock.calls[0][0];
    const from = where.concert_rel.OR.find((clause) => clause.concert_date?.gte).concert_date.gte;
    expect(from.toISOString()).toBe(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    // "Date TBA" is how the email already prints one without a date.
    expect(where.concert_rel.OR).toContainEqual({ concert_date: null });
  });

  describe('an act added to a show mailed before', () => {
    // Copenhell, found with Opeth on it weeks ago. Gojira joined it since the
    // last run. Read by when the row was created, it was never news again.
    const festival = concert(300, {
      name: 'Copenhell 2027', venue: 'Refshaleøen', city: 'Copenhagen', city_id: 40,
      created_at: new Date('2026-09-01T09:00:00Z'), bands: [{ band_rel: OPETH }, { band_rel: GOJIRA }],
    });

    beforeEach(() => {
      prisma.concertBandReference.findMany.mockResolvedValue([linked(festival, GOJIRA)]);
    });

    it('mails a festival watch, naming the act that joined', async () => {
      const send = vi.spyOn(mail, 'sendDigestEmail').mockResolvedValue({ data: { id: 'a' } });
      prisma.notificationSubscription.findMany.mockResolvedValue([subscriber(1, { band_id: null, tour_query: 'copenhell' })]);

      await runNotificationDigest();

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0].items).toEqual([expect.objectContaining({
        name: 'Copenhell 2027', bandNames: ['Opeth', 'Gojira'], newBandNames: ['Gojira'],
      })]);
    });

    it('does not mail a band watch about another act joining its band\'s show', async () => {
      const send = vi.spyOn(mail, 'sendDigestEmail').mockResolvedValue({ data: { id: 'a' } });

      await runNotificationDigest();

      expect(send).not.toHaveBeenCalled();
    });
  });

  it('presents a show new in this window as new, not as acts added to it', async () => {
    const send = vi.spyOn(mail, 'sendDigestEmail').mockResolvedValue({ data: { id: 'a' } });

    await runNotificationDigest();

    expect(send.mock.calls[0][0].items[0].newBandNames).toBeNull();
  });
});

describe('buildDigestHtml', () => {
  it('escapes scraped text and drops links that are not http', () => {
    const html = mail.buildDigestHtml([{
      name: '<img src=x onerror=alert(1)>', bandNames: [], venue: 'Debaser & Co', city: 'Stockholm', country: 'SE',
      date: '2026-11-02T19:00:00Z', url: 'javascript:alert(1)',
    }]);

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('Debaser &amp; Co');
    expect(html).not.toContain('javascript:');
  });

  it('keeps a real link', () => {
    const html = mail.buildDigestHtml([{
      name: null, bandNames: ['Opeth'], venue: 'Debaser', city: 'Stockholm', country: 'SE',
      date: '2026-11-02T19:00:00Z', url: 'https://www.songkick.com/concerts/1?a=1&b=2',
    }]);

    expect(html).toContain('<a href="https://www.songkick.com/concerts/1?a=1&amp;b=2">Opeth</a>');
  });

  it('heads an added act with the show it joined, and names the act', () => {
    const html = mail.buildDigestHtml([{
      name: 'Copenhell 2027', bandNames: ['Opeth', 'Gojira'], newBandNames: ['Gojira'],
      venue: 'Refshaleøen', city: 'Copenhagen', country: 'DK', date: '2027-06-17T00:00:00Z', url: null,
    }]);

    expect(html).toContain('<strong>Copenhell 2027</strong>');
    expect(html).toContain('New on the bill: Gojira');
  });
});
