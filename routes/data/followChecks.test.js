import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

// The sync service's side of the followed-show checker (THO-779).
const txTho779 = {
  concert: { findUnique: vi.fn(), update: vi.fn() },
  concertListingCheck: { upsert: vi.fn() },
};
const prisma = installFakePrisma({
  concert: { findMany: vi.fn() },
  $transaction: vi.fn(),
});

const { default: router } = await import('./followChecks.js');
const app = buildApp(router);
const systemTho779 = authHeader({ id: 'sync', role: 'SYSTEM' });
const userTho779 = authHeader({ id: 'user-1', role: 'USER' });

const storedShowTho779 = (over = {}) => ({
  id: 300, url: 'https://www.songkick.com/concerts/42938629-opeth', event_id: 'sk_42938629', source: 'songkick',
  on_sale: false, sold_out: false, ticket_sale_start: null,
  price_min: null, price_max: null, price_currency: null,
  vendors: null, event_status: null, tickets_opened_at: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // mockReset is on (vitest.config.js), so the transaction is wired per test.
  prisma.$transaction.mockImplementation(async (fn) => fn(txTho779));
  txTho779.concertListingCheck.upsert.mockResolvedValue({});
  txTho779.concert.update.mockResolvedValue({});
});

describe('which followed shows are due a read', () => {
  it('lists upcoming followed shows with a listing, never-read first, for the sync service only', async () => {
    prisma.concert.findMany.mockResolvedValue([
      { id: 1, url: 'https://www.songkick.com/concerts/1-a', event_id: 'sk_1', concert_date: new Date('2099-01-01'), on_sale: false, sold_out: false, ticket_sale_start: null, listing_check: { attempted_at: new Date(Date.now() - 3600 * 1000), requested_at: null } },
      { id: 2, url: null, event_id: 'sk_2', concert_date: new Date('2099-01-01'), on_sale: false, sold_out: false, ticket_sale_start: null, listing_check: null },
      { id: 3, url: 'https://www.bandsintown.com/e/3', event_id: 'bit_3', concert_date: new Date('2099-01-01'), on_sale: false, sold_out: false, ticket_sale_start: null, listing_check: null },
    ]);

    const res = await request(app).get('/follows/check-due?limit=10').set(...systemTho779);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { concert_id: 2, url: 'https://www.songkick.com/concerts/2', reason: 'never' },
      { concert_id: 1, url: 'https://www.songkick.com/concerts/1-a', reason: 'stale' },
    ]);
    // One query for the shows somebody follows, still to come.
    expect(prisma.concert.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ follows: { some: {} } }),
    }));
  });

  it('lists only what cannot wait while the full sync is running', async () => {
    prisma.concert.findMany.mockResolvedValue([
      { id: 1, url: null, event_id: 'sk_1', concert_date: null, on_sale: false, sold_out: false, ticket_sale_start: null, listing_check: null },
    ]);
    const res = await request(app).get('/follows/check-due?busy=1').set(...systemTho779);
    expect(res.body).toEqual([]);
  });

  it('refuses a user token and a limit out of range', async () => {
    expect((await request(app).get('/follows/check-due').set(...userTho779)).status).toBe(403);
    expect((await request(app).get('/follows/check-due?limit=500').set(...systemTho779)).status).toBe(400);
  });
});

describe('storing what the reads said', () => {
  it('writes the tickets, vendors and status onto the show and stamps the read', async () => {
    txTho779.concert.findUnique.mockResolvedValue(storedShowTho779());

    const res = await request(app).post('/follows/checked').set(...systemTho779).send({ results: [{
      concert_id: 300, ok: true, on_sale: false, sold_out: false, ticket_sale_start: '2099-01-10',
      vendors: [{ name: 'Eventim', url: 'https://www.eventim.de/1', state: 'on_sale_soon', sale_date: '2099-01-10', price: null }],
      event_status: 'scheduled',
    }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 1, failed: 0, unknown: 0, errors: 0 });
    expect(txTho779.concert.update).toHaveBeenCalledWith({
      where: { id: 300 },
      data: expect.objectContaining({
        ticket_sale_start: new Date('2099-01-10T00:00:00Z'),
        event_status: 'scheduled',
        vendors: [expect.objectContaining({ name: 'Eventim', state: 'on_sale_soon' })],
      }),
    });
    expect(txTho779.concertListingCheck.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { concert_id: 300 },
      update: expect.objectContaining({ failures: 0, last_error: null, checked_at: expect.any(Date), attempted_at: expect.any(Date) }),
    }));
  });

  it('stamps the read without touching the show when nothing changed', async () => {
    txTho779.concert.findUnique.mockResolvedValue(storedShowTho779({ vendors: [] }));
    const res = await request(app).post('/follows/checked').set(...systemTho779).send({ results: [{ concert_id: 300, ok: true, vendors: [] }] });
    expect(res.body.updated).toBe(1);
    expect(txTho779.concert.update).not.toHaveBeenCalled();
    expect(txTho779.concertListingCheck.upsert).toHaveBeenCalled();
  });

  it('counts a failed read against the listing and moves the attempt on, without writing the show', async () => {
    txTho779.concert.findUnique.mockResolvedValue(storedShowTho779());

    const res = await request(app).post('/follows/checked').set(...systemTho779).send({ results: [
      { concert_id: 300, ok: false, error: 'HTTP 403', blocked: true },
    ] });

    expect(res.body).toEqual({ updated: 0, failed: 1, unknown: 0, errors: 0 });
    expect(txTho779.concert.update).not.toHaveBeenCalled();
    expect(txTho779.concertListingCheck.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ failures: { increment: 1 }, last_error: 'blocked: HTTP 403', attempted_at: expect.any(Date) }),
    }));
    // A failed read is not a successful one.
    expect(txTho779.concertListingCheck.upsert.mock.calls[0][0].update).not.toHaveProperty('checked_at');
  });

  it('stamps each read with the time the page was read, so a "Check now" pressed mid-tick stays pending', async () => {
    // THO-907: the batch is posted after the tick's last page, so stamping it
    // with the post cleared a request made after this page had been read.
    txTho779.concert.findUnique.mockResolvedValue(storedShowTho779({ vendors: [] }));
    const readAtTho907 = new Date(Date.now() - 2 * 60 * 1000);

    await request(app).post('/follows/checked').set(...systemTho779).send({ results: [
      { concert_id: 300, ok: true, vendors: [], read_at: readAtTho907.toISOString() },
      { concert_id: 301, ok: false, error: 'timeout', read_at: readAtTho907.toISOString() },
    ] });

    const [read, failedRead] = txTho779.concertListingCheck.upsert.mock.calls.map(([args]) => args.update);
    expect(read).toMatchObject({ checked_at: readAtTho907, attempted_at: readAtTho907 });
    expect(failedRead).toMatchObject({ attempted_at: readAtTho907 });
  });

  it('counts a show deleted since it was listed, or an id that is not one, as unknown', async () => {
    txTho779.concert.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/follows/checked').set(...systemTho779).send({ results: [
      { concert_id: 300, ok: true }, { concert_id: 'x', ok: true },
    ] });
    expect(res.body).toEqual({ updated: 0, failed: 0, unknown: 2, errors: 0 });
    expect(txTho779.concertListingCheck.upsert).not.toHaveBeenCalled();
  });

  it('keeps going past a show whose write failed, and says so', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma.$transaction
      .mockImplementationOnce(async () => { throw new Error('deadlock'); })
      .mockImplementation(async (fn) => fn(txTho779));
    txTho779.concert.findUnique.mockResolvedValue(storedShowTho779());

    const res = await request(app).post('/follows/checked').set(...systemTho779).send({ results: [
      { concert_id: 300, ok: true }, { concert_id: 301, ok: true },
    ] });

    expect(res.body).toEqual({ updated: 1, failed: 0, unknown: 0, errors: 1 });
  });

  it('refuses a batch that is not a list, one over a hundred, and a user token', async () => {
    expect((await request(app).post('/follows/checked').set(...systemTho779).send({ results: 'x' })).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => ({ concert_id: i + 1, ok: false }));
    expect((await request(app).post('/follows/checked').set(...systemTho779).send({ results: many })).status).toBe(400);
    expect((await request(app).post('/follows/checked').set(...userTho779).send({ results: [] })).status).toBe(403);
  });
});
