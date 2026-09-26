import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { installFakePrisma } from '../test/routeApp.js';

const prisma = installFakePrisma({
  notificationDigestRun: {
    findFirst: vi.fn(async () => ({ id: 1, last_run_at: new Date('2026-09-25T08:00:00Z') })),
    create: vi.fn(),
    update: vi.fn(async () => ({})),
  },
  concert: { findMany: vi.fn() },
  notificationSubscription: { findMany: vi.fn() },
  wishlist: { findMany: vi.fn(async () => []) },
});

// This file's own copies — it is CommonJS and loads them through Node's
// require, which an ESM import would not share.
const require = createRequire(import.meta.url);
const mail = require('./mail.js');
const { runNotificationDigest } = require('./concertNotifyDigest.js');

const concert = (id) => ({
  id, name: null, venue: 'Debaser', city: 'Stockholm', country: 'SE', city_id: 12,
  concert_date: new Date('2026-11-02T19:00:00Z'), url: null,
  bands: [{ band_rel: { id: 9, name: 'Opeth' } }],
});
const subscriber = (id) => ({ id, user_id: `user-${id}`, band_id: 9, city_id: null, user_rel: { id: `user-${id}`, email: `u${id}@example.test` } });

beforeEach(() => {
  prisma.concert.findMany.mockResolvedValue([concert(100)]);
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
});
