import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { installFakePrisma } from '../test/routeApp.js';

const prisma = installFakePrisma({
  concertFollow: { findMany: vi.fn(), update: vi.fn(async () => ({})) },
});

// This file's own copies — CommonJS, loaded through Node's require.
const require = createRequire(import.meta.url);
const mail = require('./mail.js');
const { ticketState } = require('./ticketState.js');
const { alertFor, runTicketAlerts } = require('./ticketAlerts.js');

const NOW = new Date('2026-10-09T06:30:00Z'); // 08:30 in Stockholm, the sale day

describe('ticketState', () => {
  it('reads sold out, then on sale, then a sale day still to come', () => {
    expect(ticketState({ sold_out: true, on_sale: true }, NOW)).toBe('sold_out');
    expect(ticketState({ on_sale: true }, NOW)).toBe('on_sale');
    expect(ticketState({ ticket_sale_start: new Date('2026-10-09T00:00:00Z') }, NOW)).toBe('on_sale_soon');
    expect(ticketState({ ticket_sale_start: new Date('2026-10-01T00:00:00Z') }, NOW)).toBe('unknown');
    expect(ticketState({}, NOW)).toBe('unknown');
  });
});

describe('alertFor', () => {
  const at = (hour, day = '2026-10-09') => ({ saleDay: '2026-10-09', today: day, hour });
  const told = (state, extra = {}) => ({ told_state: state, reminded_at: null, ...extra });

  it('warns when a show sells out, whatever it was before', () => {
    expect(alertFor(told('on_sale'), 'sold_out', at(12))).toBe('sold_out');
    expect(alertFor(told('unknown'), 'sold_out', at(12))).toBe('sold_out');
  });

  it('says tickets are back when a sold-out show is on sale again', () => {
    expect(alertFor(told('sold_out'), 'on_sale', at(12))).toBe('back');
  });

  it('says a show is on sale once it is', () => {
    expect(alertFor(told('on_sale_soon'), 'on_sale', at(12))).toBe('on_sale');
  });

  it('reminds on the morning of the sale, once', () => {
    expect(alertFor(told('on_sale_soon'), 'on_sale_soon', at(7))).toBeNull();
    expect(alertFor(told('on_sale_soon'), 'on_sale_soon', at(8))).toBe('sale_today');
    expect(alertFor(told('on_sale_soon', { reminded_at: NOW }), 'on_sale_soon', at(9))).toBeNull();
    expect(alertFor(told('on_sale_soon'), 'on_sale_soon', at(9, '2026-10-08'))).toBeNull();
  });

  it('says nothing about a change that is not news', () => {
    // A sale date appearing, or the sources going quiet, only moves told_state.
    expect(alertFor(told('on_sale'), 'on_sale_soon', at(12))).toBeNull();
    expect(alertFor(told('sold_out'), 'unknown', at(12))).toBeNull();
    expect(alertFor(told('on_sale'), 'on_sale', at(12))).toBeNull();
  });
});

describe('runTicketAlerts', () => {
  // A real socket for Discord: the module requires axios through CommonJS.
  let server;
  let received;
  let answer;
  const hook = () => `http://127.0.0.1:${server.address().port}/hook`;

  beforeAll(async () => {
    const { createServer } = await import('node:http');
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(answer()); res.end(); });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  const show = (over = {}) => ({
    id: 300, name: 'Hollywood Undead: EU/UK 2027', venue: 'Fållan', city: 'Stockholm', country: 'SE',
    concert_date: new Date('2027-02-13T18:45:00Z'), url: 'https://www.songkick.com/festivals/3808399/id/43451188',
    metadata: null, on_sale: false, sold_out: false, ticket_sale_start: null,
    bands: [{ band_rel: { name: 'Hollywood Undead' } }], ...over,
  });
  const follow = (told, concert, user = {}) => ({
    user_id: 'me', concert_id: concert.id, told_state: told, reminded_at: null, concert_rel: concert,
    user_rel: { email: 'me@example.test', settings: { timeZone: 'Europe/Stockholm', discord_user_id: '42' }, wishlists: { discord_webhook: hook() }, ...user },
  });
  const updates = () => prisma.concertFollow.update.mock.calls.map(([arg]) => arg.data);

  beforeEach(() => {
    vi.clearAllMocks();
    received = [];
    answer = () => 204;
    vi.spyOn(mail, 'sendTicketAlertEmail').mockResolvedValue({ data: { id: 'x' } });
  });

  it('warns a follower on Discord and by email when a show sells out, and remembers telling them', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([follow('on_sale', show({ on_sale: true, sold_out: true }))]);

    const result = await runTicketAlerts({ now: NOW });

    expect(result).toMatchObject({ alerted: 1, failed: 0 });
    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('<@42>');
    expect(received[0].embeds[0].title).toBe('Sold out: Hollywood Undead: EU/UK 2027');
    expect(received[0].embeds[0].fields[0].value).toContain('**Sold out**');
    expect(mail.sendTicketAlertEmail).toHaveBeenCalledWith({
      to: 'me@example.test',
      items: [expect.objectContaining({ alert: 'Sold out', title: 'Hollywood Undead: EU/UK 2027' })],
    });
    expect(updates()).toEqual([{ told_state: 'sold_out' }]);
  });

  it('reminds on the sale day, on the follower\'s clock, and marks it sent', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([
      follow('on_sale_soon', show({ ticket_sale_start: new Date('2026-10-09T00:00:00Z') })),
    ]);

    await runTicketAlerts({ now: NOW });

    expect(received[0].embeds[0].title).toBe('On sale today: Hollywood Undead: EU/UK 2027');
    expect(updates()).toEqual([{ told_state: 'on_sale_soon', reminded_at: NOW }]);
  });

  it('puts several shows in one message', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([
      follow('on_sale', show({ sold_out: true })),
      follow('sold_out', show({ id: 301, name: 'Copenhell 2027', on_sale: true })),
    ]);

    await runTicketAlerts({ now: NOW });

    expect(received).toHaveLength(1);
    expect(received[0].embeds[0].title).toBe('Tickets for shows you follow');
    expect(received[0].embeds[0].fields.map((f) => f.value.split('\n')[1])).toEqual(['**Sold out**', '**Tickets are back on sale**']);
  });

  it('keeps it owed when it could be sent nowhere, so the next run tries again', async () => {
    answer = () => 503;
    mail.sendTicketAlertEmail.mockRejectedValue(new Error('Email service error'));
    prisma.concertFollow.findMany.mockResolvedValue([follow('on_sale', show({ sold_out: true }))]);

    const result = await runTicketAlerts({ now: NOW });

    expect(result).toMatchObject({ alerted: 0, failed: 1 });
    expect(prisma.concertFollow.update).not.toHaveBeenCalled();
  });

  it('counts it told when either channel took it', async () => {
    answer = () => 404;
    prisma.concertFollow.findMany.mockResolvedValue([follow('on_sale', show({ sold_out: true }))]);

    const result = await runTicketAlerts({ now: NOW });

    expect(result.alerted).toBe(1);
    expect(updates()).toEqual([{ told_state: 'sold_out' }]);
  });

  it('moves told_state on quietly for a change that is not news', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([
      follow('on_sale', show({ ticket_sale_start: new Date('2026-11-01T00:00:00Z') })),
    ]);

    await runTicketAlerts({ now: NOW });

    expect(received).toHaveLength(0);
    expect(mail.sendTicketAlertEmail).not.toHaveBeenCalled();
    expect(updates()).toEqual([{ told_state: 'on_sale_soon' }]);
  });

  it('reads only shows still to come', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([]);

    await runTicketAlerts({ now: NOW });

    const { where } = prisma.concertFollow.findMany.mock.calls[0][0];
    expect(where.concert_rel.OR).toContainEqual({ concert_date: { gte: new Date('2026-10-09T00:00:00Z') } });
  });
});
