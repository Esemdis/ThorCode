import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { installFakePrisma } from '../test/routeApp.js';

const prisma = installFakePrisma({
  concertFollow: { findMany: vi.fn(), update: vi.fn(async () => ({})) },
});

// This file's own copies — CommonJS, loaded through Node's require.
const require = createRequire(import.meta.url);
const mail = require('./mail.js');
const { ticketState, mergeTicketFields } = require('./ticketState.js');
const {
  alertFor, saleInstant, billJoined, billLabel, ticketLink, runTicketAlerts, runTicketAlertsSerially,
  statusAlert, movedSince, movedLabel, priceLabel, vendorLinks, alertDetails,
} = require('./ticketAlerts.js');

const NOW = new Date('2026-10-09T06:30:00Z'); // 08:30 in Stockholm, the sale day

describe('ticketState', () => {
  it('reads sold out, then on sale, then a sale day still to come', () => {
    expect(ticketState({ sold_out: true, on_sale: true }, NOW)).toBe('sold_out');
    expect(ticketState({ on_sale: true }, NOW)).toBe('on_sale');
    expect(ticketState({ ticket_sale_start: new Date('2026-10-09T00:00:00Z') }, NOW)).toBe('on_sale_soon');
    expect(ticketState({ ticket_sale_start: new Date('2026-10-01T00:00:00Z') }, NOW)).toBe('unknown');
    expect(ticketState({}, NOW)).toBe('unknown');
  });

  it('believes the day a sale opens over a flag saying it already has', () => {
    // How the Hollywood Undead row read "On sale" three days before its sale:
    // Bandsintown marks every listing in stock, Songkick's own page said the
    // 9th, and the flag was being read first.
    const soon = { on_sale: true, ticket_sale_start: new Date('2026-10-11T00:00:00Z') };

    expect(ticketState(soon, NOW)).toBe('on_sale_soon');
    // On the morning of the sale the flag is the newer news again.
    expect(ticketState({ ...soon, ticket_sale_start: new Date('2026-10-09T00:00:00Z') }, NOW)).toBe('on_sale');
  });
});

describe('mergeTicketFields', () => {
  // The merge paths put rows from different sources onto one stored row,
  // which is what most of this is about: one source's silence must not undo
  // another's news.
  const now = new Date('2026-10-07T12:00:00Z');
  const merge = (existing, incoming) => mergeTicketFields(existing, incoming, now);
  // A stored row as the database holds one: every ticket field set.
  const stored = (over = {}) => ({ on_sale: true, sold_out: false, ticket_sale_start: null, ...over });
  const pending = stored({ on_sale: false, ticket_sale_start: new Date('2026-10-09T00:00:00Z') });

  it('saves a sale day still to come, and says the show is not on sale', () => {
    expect(merge(stored(), { on_sale: false, sold_out: false, ticket_sale_start: '2026-10-09' }))
      .toEqual({ ticket_sale_start: new Date('2026-10-09T00:00:00Z'), on_sale: false });
  });

  it('records a sell-out whatever else the scrape claims', () => {
    expect(merge(stored(), { sold_out: true, on_sale: true })).toEqual({ sold_out: true, on_sale: false });
  });

  it('lets a bare "in stock" neither clear a sale day nor contradict it', () => {
    // Both sources mark a listing in stock by default, so this is the claim
    // that must not win. It would fire "on sale now" days early.
    expect(merge(pending, { on_sale: true, sold_out: false })).toEqual({});
  });

  it('takes a scrape at its word once the sale day has passed', () => {
    const was = stored({ on_sale: false, ticket_sale_start: new Date('2026-01-01T00:00:00Z') });

    expect(merge(was, { on_sale: true, sold_out: false })).toEqual({ on_sale: true });
  });

  it('lets a sale be recorded on the day it opens', () => {
    // The stored day is today: a source that has looked and says the show is
    // selling is the newer news, or "on sale now" waits until tomorrow.
    const today = stored({ on_sale: false, ticket_sale_start: new Date('2026-10-07T00:00:00Z') });

    expect(merge(today, { on_sale: true, sold_out: false })).toEqual({ on_sale: true });
    // A scrape that still reads "on sale today" off the vendor list holds.
    expect(merge(today, { on_sale: false, sold_out: false, ticket_sale_start: '2026-10-07' })).toEqual({});
  });

  it('brings a sold-out show back only when a source says it is selling again', () => {
    const gone = stored({ on_sale: false, sold_out: true });

    expect(merge(gone, { sold_out: false, on_sale: true })).toEqual({ sold_out: false, on_sale: true });
    expect(merge(gone, { sold_out: false, on_sale: false })).toEqual({});
  });

  it('writes nothing when the scrape says nothing, or only what the row already holds', () => {
    expect(merge(pending, {})).toEqual({});
    expect(merge(stored(), { on_sale: true, sold_out: false })).toEqual({});
  });

  it('leaves the flag alone for a scrape that read nothing about the tickets', () => {
    // A null is how the scrapers say nobody looked, and on_sale cannot be
    // null in the database — writing one through would throw.
    expect(merge(stored(), { on_sale: null, sold_out: false })).toEqual({});
    expect(merge(stored({ on_sale: false }), { on_sale: null, sold_out: false })).toEqual({});
  });
});

describe('ticketLink', () => {
  it('names the site a show was listed on', () => {
    expect(ticketLink({ url: 'https://www.songkick.com/concerts/1', source: 'songkick' }))
      .toEqual({ url: 'https://www.songkick.com/concerts/1', label: 'Tickets on Songkick' });
    expect(ticketLink({ url: 'https://www.bandsintown.com/e/1', source: 'bandsintown' }).label)
      .toBe('Tickets on Bandsintown');
    expect(ticketLink({ url: 'https://tickets.example.test/1', source: null }).label).toBe('Tickets');
  });

  it('is nothing at all for a row with no link, or one that is not a link', () => {
    expect(ticketLink({ url: null })).toBeNull();
    // These went into an email as an href and into Discord as markdown.
    expect(ticketLink({ url: 'javascript:alert(1)' })).toBeNull();
  });
});

describe('saleInstant', () => {
  const day = (iso) => ({ ticket_sale_start: new Date(iso) });

  it('assumes ten in the morning, local, when only the day is known', () => {
    // Which is every sale today: Songkick names the day and nothing more.
    expect(saleInstant(day('2026-11-02T00:00:00Z'), 'Europe/Stockholm'))
      .toEqual({ at: new Date('2026-11-02T09:00:00Z'), assumed: true });
  });

  it('follows the follower\'s clock through the summer change', () => {
    expect(saleInstant(day('2026-07-02T00:00:00Z'), 'Europe/Stockholm').at).toEqual(new Date('2026-07-02T08:00:00Z'));
    expect(saleInstant(day('2026-11-02T00:00:00Z'), 'UTC').at).toEqual(new Date('2026-11-02T10:00:00Z'));
  });

  it('takes a time it was actually given', () => {
    expect(saleInstant(day('2026-11-02T08:00:00Z'), 'Europe/Stockholm'))
      .toEqual({ at: new Date('2026-11-02T08:00:00Z'), assumed: false });
  });

  it('is nothing at all without a sale date', () => {
    expect(saleInstant({}, 'Europe/Stockholm')).toBeNull();
  });
});

describe('alertFor', () => {
  // The sale opens at 10:00 in Stockholm on 2 November, so the reminder is
  // due at 09:50 there, which is 08:50 UTC.
  const sale = { at: new Date('2026-11-02T09:00:00Z'), assumed: true };
  const at = (iso) => ({ sale, now: new Date(iso) });
  const told = (state, extra = {}) => ({ told_state: state, reminded_at: null, ...extra });

  it('warns when a show sells out, whatever it was before', () => {
    expect(alertFor(told('on_sale'), 'sold_out', at('2026-11-02T09:00:00Z'))).toBe('sold_out');
    expect(alertFor(told('unknown'), 'sold_out', at('2026-11-02T09:00:00Z'))).toBe('sold_out');
  });

  it('says tickets are back when a sold-out show is on sale again', () => {
    expect(alertFor(told('sold_out'), 'on_sale', at('2026-11-02T09:00:00Z'))).toBe('back');
  });

  it('says a show is on sale once it is', () => {
    expect(alertFor(told('on_sale_soon'), 'on_sale', at('2026-11-02T09:00:00Z'))).toBe('on_sale');
  });

  it('reminds ten minutes before the sale, and only once', () => {
    expect(alertFor(told('on_sale_soon'), 'on_sale_soon', at('2026-11-02T08:44:00Z'))).toBeNull();
    expect(alertFor(told('on_sale_soon'), 'on_sale_soon', at('2026-11-02T08:50:00Z'))).toBe('sale_today');
    expect(alertFor(told('on_sale_soon', { reminded_at: new Date() }), 'on_sale_soon', at('2026-11-02T08:50:00Z'))).toBeNull();
  });

  it('is not due the day before, nor at eight on the morning itself', () => {
    expect(alertFor(told('on_sale_soon'), 'on_sale_soon', at('2026-11-01T20:00:00Z'))).toBeNull();
    expect(alertFor(told('on_sale_soon'), 'on_sale_soon', at('2026-11-02T07:00:00Z'))).toBeNull();
  });

  it('goes out late rather than never when the job has been down', () => {
    expect(alertFor(told('on_sale_soon'), 'on_sale_soon', at('2026-11-02T11:00:00Z'))).toBe('sale_today');
  });

  it('says nothing about a change that is not news', () => {
    // A sale date appearing, or the sources going quiet, only moves told_state.
    expect(alertFor(told('on_sale'), 'on_sale_soon', { sale: null, now: new Date() })).toBeNull();
    expect(alertFor(told('sold_out'), 'unknown', { sale: null, now: new Date() })).toBeNull();
    expect(alertFor(told('on_sale'), 'on_sale', { sale: null, now: new Date() })).toBeNull();
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
    source: 'songkick', metadata: null, on_sale: false, sold_out: false, ticket_sale_start: null,
    bands: [{ band_rel: { name: 'Hollywood Undead' } }], ...over,
  });
  // `bill` is the bill this follower was last told about, which for most of
  // these is simply the one on the show: nothing has joined it.
  // Told the show was going ahead, on its day and at its venue, as a follow
  // made since the checker shipped is.
  const follow = (told, concert, user = {}, bill = concert.bands.map((b) => b.band_rel.name)) => ({
    user_id: 'me', concert_id: concert.id, told_state: told, reminded_at: null, concert_rel: concert,
    lineup_told: bill === null ? null : JSON.stringify(bill),
    status_told: 'scheduled', date_told: concert.concert_date, venue_told: concert.venue,
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

  it('reminds ten minutes before the sale, on the follower\'s clock, and marks it sent', async () => {
    // 9 October is summer time in Stockholm, so 09:50 there is 07:50 UTC.
    const soon = new Date('2026-10-09T07:50:00Z');
    prisma.concertFollow.findMany.mockResolvedValue([
      follow('on_sale_soon', show({ ticket_sale_start: new Date('2026-10-09T00:00:00Z') })),
    ]);

    // Half past eight on their clock is still too early.
    await runTicketAlerts({ now: NOW });
    expect(received).toHaveLength(0);

    await runTicketAlerts({ now: soon });

    expect(received[0].embeds[0].title).toBe('On sale today: Hollywood Undead: EU/UK 2027');
    expect(updates()).toEqual([{ told_state: 'on_sale_soon', reminded_at: soon }]);
  });

  it('sends the listing to buy from with every alert, named after its site', async () => {
    const soon = new Date('2026-10-09T07:50:00Z');
    prisma.concertFollow.findMany.mockResolvedValue([
      follow('on_sale_soon', show({ ticket_sale_start: new Date('2026-10-09T00:00:00Z') })),
    ]);

    await runTicketAlerts({ now: soon });

    expect(received[0].embeds[0].fields[0].value)
      .toContain('🎟 [Tickets on Songkick](https://www.songkick.com/festivals/3808399/id/43451188)');
    expect(mail.sendTicketAlertEmail).toHaveBeenCalledWith({
      to: 'me@example.test',
      items: [expect.objectContaining({
        tickets: { url: 'https://www.songkick.com/festivals/3808399/id/43451188', label: 'Tickets on Songkick' },
      })],
    });
  });

  it('names a sale time it was given, rather than the hour it assumes', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([
      follow('on_sale_soon', show({ ticket_sale_start: new Date('2026-10-09T09:00:00Z') })),
    ]);

    await runTicketAlerts({ now: new Date('2026-10-09T08:50:00Z') });

    expect(received[0].embeds[0].title).toBe('On sale at 11:00: Hollywood Undead: EU/UK 2027');
  });

  it('puts several shows in one message', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([
      follow('on_sale', show({ sold_out: true })),
      follow('sold_out', show({ id: 301, name: 'Copenhell 2027', on_sale: true })),
    ]);

    await runTicketAlerts({ now: NOW });

    expect(received).toHaveLength(1);
    expect(received[0].embeds[0].title).toBe('News about shows you follow');
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

  it('tells a follower which acts have joined the bill, however the show lists them', async () => {
    // The acts with a Band row and the plain names in metadata, together: most
    // of what joins a festival's bill has no row at all.
    const bill = show({
      name: 'Copenhell 2027',
      metadata: JSON.stringify(['Ghost', 'Uncle Acid & the Deadbeats']),
      bands: [{ band_rel: { name: 'Hollywood Undead' } }, { band_rel: { name: 'Opeth' } }],
    });
    prisma.concertFollow.findMany.mockResolvedValue([follow('unknown', bill, {}, ['Hollywood Undead', 'Ghost'])]);

    const result = await runTicketAlerts({ now: NOW });

    expect(result).toMatchObject({ alerted: 1, failed: 0 });
    expect(received[0].embeds[0].title).toBe('New on the bill: Copenhell 2027');
    expect(received[0].embeds[0].fields[0].value).toContain('**New on the bill: Opeth, Uncle Acid & the Deadbeats**');
    expect(mail.sendTicketAlertEmail).toHaveBeenCalledWith({
      to: 'me@example.test',
      items: [expect.objectContaining({ alert: 'New on the bill: Opeth, Uncle Acid & the Deadbeats' })],
    });
    // The whole bill, so the next act to join is the only news next time.
    expect(updates()).toEqual([{
      told_state: 'unknown',
      lineup_told: JSON.stringify(['Hollywood Undead', 'Opeth', 'Ghost', 'Uncle Acid & the Deadbeats']),
    }]);
  });

  it('says nothing about the bill a follow was made on, or about one it has never seen', async () => {
    const bill = show({ metadata: JSON.stringify(['Ghost']) });
    prisma.concertFollow.findMany.mockResolvedValue([
      // Followed with both acts already on it.
      follow('unknown', bill, {}, ['Hollywood Undead', 'Ghost']),
    ]);

    await runTicketAlerts({ now: NOW });
    expect(received).toHaveLength(0);
    expect(prisma.concertFollow.update).not.toHaveBeenCalled();

    // A follow from before any bill was recorded: the first pass remembers it
    // quietly rather than reading the whole lineup out as news.
    vi.clearAllMocks();
    prisma.concertFollow.findMany.mockResolvedValue([follow('unknown', bill, {}, null)]);

    await runTicketAlerts({ now: NOW });

    expect(received).toHaveLength(0);
    expect(updates()).toEqual([{ lineup_told: JSON.stringify(['Hollywood Undead', 'Ghost']) }]);
  });

  it('counts a scrape that renames an act, or drops one, as no news', async () => {
    // "Architects (UK)" is the band row's "Architects" with the scraper's
    // disambiguator on it, which is not an act joining anything.
    const renamed = show({ bands: [{ band_rel: { name: 'Architects (UK)' } }] });
    prisma.concertFollow.findMany.mockResolvedValue([follow('unknown', renamed, {}, ['Architects'])]);

    await runTicketAlerts({ now: NOW });
    expect(received).toHaveLength(0);
    expect(prisma.concertFollow.update).not.toHaveBeenCalled();

    // An act off the bill is worth remembering — so its coming back is news —
    // and not worth a message.
    vi.clearAllMocks();
    prisma.concertFollow.findMany.mockResolvedValue([
      follow('unknown', show(), {}, ['Hollywood Undead', 'Ghost']),
    ]);

    await runTicketAlerts({ now: NOW });

    expect(received).toHaveLength(0);
    expect(updates()).toEqual([{ lineup_told: JSON.stringify(['Hollywood Undead']) }]);
  });

  it('puts a sell-out and a new act on the same show in one message', async () => {
    const bill = show({ sold_out: true, metadata: JSON.stringify(['Ghost']) });
    prisma.concertFollow.findMany.mockResolvedValue([follow('on_sale', bill, {}, ['Hollywood Undead'])]);

    await runTicketAlerts({ now: NOW });

    expect(received).toHaveLength(1);
    expect(received[0].embeds[0].title).toBe('News about shows you follow');
    expect(received[0].embeds[0].fields.map((f) => f.value.split('\n')[1]))
      .toEqual(['**Sold out**', '**New on the bill: Ghost**']);
    // One write for the follow, not one per line.
    expect(updates()).toEqual([{ told_state: 'sold_out', lineup_told: JSON.stringify(['Hollywood Undead', 'Ghost']) }]);
  });

  it('names the acts that joined, and counts the rest once the line is full', () => {
    expect(billLabel(['Ghost', 'Opeth'])).toBe('New on the bill: Ghost, Opeth');
    // Twenty acts of twelve characters: the line names as many as fit in 200.
    const many = Array.from({ length: 20 }, (_, i) => `Band ${i}`.padEnd(12, '.'));
    const label = billLabel(many);
    expect(label.length).toBeLessThan(240);
    expect(label).toMatch(/and \d+ more$/);
    // One act whose name is longer than the whole line is still named.
    expect(billLabel(['x'.repeat(400)])).toBe(`New on the bill: ${'x'.repeat(400)}`);
    expect(billJoined(null, ['Ghost'])).toEqual([]);
    expect(billJoined(['Ghost'], ['Ghost', 'Opeth'])).toEqual(['Opeth']);
  });

  it('says a show is cancelled, and nothing else about it', async () => {
    // Sold out and an act joining in the same pass: neither is news about a
    // show that is off. Both are still recorded, so nothing is owed later.
    const off = show({ event_status: 'cancelled', sold_out: true, metadata: JSON.stringify(['Ghost']) });
    prisma.concertFollow.findMany.mockResolvedValue([follow('on_sale', off, {}, ['Hollywood Undead'])]);

    await runTicketAlerts({ now: NOW });

    expect(received[0].embeds[0].title).toBe('Cancelled: Hollywood Undead: EU/UK 2027');
    expect(received[0].embeds[0].fields.map((f) => f.value.split('\n')[1])).toEqual(['**Cancelled**']);
    expect(updates()).toEqual([{
      told_state: 'sold_out',
      lineup_told: JSON.stringify(['Hollywood Undead', 'Ghost']),
      status_told: 'cancelled',
    }]);
  });

  it('says a postponed show is going ahead again, and where it went', async () => {
    const back = show({ concert_date: new Date('2027-03-14T18:45:00Z'), venue: 'Annexet' });
    prisma.concertFollow.findMany.mockResolvedValue([{
      ...follow('unknown', back),
      status_told: 'postponed',
      date_told: new Date('2027-02-13T18:45:00Z'),
      venue_told: 'Fållan',
    }]);

    await runTicketAlerts({ now: NOW });

    expect(received[0].embeds[0].fields.map((f) => f.value.split('\n')[1])).toEqual([
      '**Going ahead again**',
      '**Moved to 14 Mar 2027 (was 13 Feb 2027) and to Annexet (was Fållan)**',
    ]);
    expect(mail.sendTicketAlertEmail).toHaveBeenCalledWith({
      to: 'me@example.test',
      items: [
        expect.objectContaining({ alert: 'Going ahead again', headline: 'Going ahead again: Hollywood Undead: EU/UK 2027' }),
        expect.objectContaining({ headline: 'Moved: Hollywood Undead: EU/UK 2027' }),
      ],
    });
    expect(updates()).toEqual([{
      told_state: 'unknown',
      status_told: 'scheduled',
      date_told: new Date('2027-03-14T18:45:00Z'),
      venue_told: 'Annexet',
    }]);
  });

  it('records where and when a show is for a follow that never did, and says nothing', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([{
      ...follow('unknown', show()), status_told: null, date_told: null, venue_told: null,
    }]);

    await runTicketAlerts({ now: NOW });

    expect(received).toHaveLength(0);
    expect(updates()).toEqual([{
      status_told: 'scheduled', date_told: new Date('2027-02-13T18:45:00Z'), venue_told: 'Fållan',
    }]);
  });

  it('counts a start time filled in on the same night as no move', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([{
      ...follow('unknown', show()), date_told: new Date('2027-02-13T00:00:00Z'),
    }]);

    await runTicketAlerts({ now: NOW });

    expect(received).toHaveLength(0);
    expect(prisma.concertFollow.update).not.toHaveBeenCalled();
  });

  it('names the vendors selling, the price and when the sale was spotted opening', async () => {
    const opened = show({
      on_sale: true, price_min: 45, price_max: 89.5, price_currency: 'EUR',
      tickets_opened_at: new Date('2026-10-09T08:02:00Z'),
      ticket_vendors: [
        { name: 'Ticketmaster', state: 'on_sale', url: 'https://www.ticketmaster.se/event/1' },
        { name: 'Eventim', state: 'sold_out', url: 'https://www.eventim.se/event/2' },
        { name: 'AXS', state: 'on_sale', url: 'javascript:alert(1)' },
      ],
    });
    prisma.concertFollow.findMany.mockResolvedValue([follow('on_sale_soon', opened)]);

    await runTicketAlerts({ now: new Date('2026-10-09T08:05:00Z') });

    const [, note, details, tickets] = received[0].embeds[0].fields[0].value.split('\n');
    expect(note).toBe('**On sale now**');
    // 08:02 UTC is 10:02 in Stockholm in October.
    expect(details).toBe('€45–89.50 · Spotted on sale at 10:02');
    expect(tickets).toBe('🎟 [Ticketmaster](https://www.ticketmaster.se/event/1) · '
      + '[Tickets on Songkick](https://www.songkick.com/festivals/3808399/id/43451188)');
    expect(mail.sendTicketAlertEmail).toHaveBeenCalledWith({
      to: 'me@example.test',
      items: [expect.objectContaining({
        links: [{ label: 'Ticketmaster', url: 'https://www.ticketmaster.se/event/1' }],
        details: ['€45–89.50', 'Spotted on sale at 10:02'],
      })],
    });
  });

  it('reads only shows still to come', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([]);

    await runTicketAlerts({ now: NOW });

    const { where } = prisma.concertFollow.findMany.mock.calls[0][0];
    expect(where.concert_rel.OR).toContainEqual({ concert_date: { gte: new Date('2026-10-09T00:00:00Z') } });
  });
});

describe('what an alert says beyond itself', () => {
  it('reads a show going ahead, off or postponed, from what the follower was told', () => {
    expect(statusAlert('scheduled', 'cancelled')).toBe('cancelled');
    expect(statusAlert('scheduled', 'postponed')).toBe('postponed');
    expect(statusAlert('postponed', 'scheduled')).toBe('reinstated');
    expect(statusAlert('cancelled', 'postponed')).toBe('postponed');
    expect(statusAlert('scheduled', 'scheduled')).toBeNull();
    // Never recorded: nothing to compare with, so nothing is news.
    expect(statusAlert(null, 'cancelled')).toBeNull();
  });

  it('moves a show by its day and its venue, and only when it was told one', () => {
    const was = { date_told: new Date('2027-02-13T18:45:00Z'), venue_told: 'Fållan' };
    expect(movedSince(was, { concert_date: new Date('2027-02-13T20:00:00Z'), venue: 'Fållan' })).toEqual({});
    expect(movedSince(was, { concert_date: new Date('2027-02-14T18:45:00Z'), venue: 'Fållan' }).date)
      .toEqual({ from: new Date('2027-02-13T18:45:00Z'), to: new Date('2027-02-14T18:45:00Z') });
    expect(movedSince({ date_told: null, venue_told: null }, { concert_date: new Date(), venue: 'Annexet' })).toEqual({});
    expect(movedLabel({ venue: { from: 'Fållan', to: 'Annexet' } })).toBe('Moved to Annexet (was Fållan)');
  });

  it('prices a show the way the listing does', () => {
    expect(priceLabel({ price_min: 45, price_max: 89, price_currency: 'EUR' })).toBe('€45–89');
    expect(priceLabel({ price_min: 34.5, price_max: null, price_currency: 'GBP' })).toBe('From £34.50');
    expect(priceLabel({ price_min: 450, price_max: 690, price_currency: 'SEK' })).toBe('450–690 SEK');
    expect(priceLabel({ price_min: 30, price_max: 30, price_currency: 'USD' })).toBe('$30');
    expect(priceLabel({ price_min: null, price_max: 60, price_currency: null })).toBe('Up to 60');
    expect(priceLabel({})).toBeNull();
  });

  it('links the vendors that fit the alert, once each, at most three', () => {
    const vendor = (name, state, n = 1) => ({ name, state, url: `https://${name.toLowerCase()}.test/${n}` });
    const concert = { ticket_vendors: [
      vendor('Ticketmaster', 'on_sale'), vendor('Ticketmaster', 'on_sale', 2), vendor('Eventim', 'on_sale_soon'),
      vendor('AXS', 'on_sale'), vendor('Dice', 'on_sale'), vendor('Tixly', 'on_sale'),
    ] };
    expect(vendorLinks(concert, 'on_sale').map((l) => l.label)).toEqual(['Ticketmaster', 'AXS', 'Dice']);
    expect(vendorLinks(concert, 'sale_today').map((l) => l.label)).toEqual(['Ticketmaster', 'Eventim', 'AXS']);
    // An alert that is not about buying links none, nor does a row never checked.
    expect(vendorLinks(concert, 'sold_out')).toEqual([]);
    expect(vendorLinks({ ticket_vendors: null }, 'on_sale')).toEqual([]);
  });

  it('says when a sale was spotted only while that is news', () => {
    const concert = { tickets_opened_at: new Date('2026-10-09T08:02:00Z') };
    const at = (iso) => ({ timeZone: 'Europe/Stockholm', now: new Date(iso) });
    expect(alertDetails(concert, 'on_sale', at('2026-10-09T08:05:00Z'))).toEqual(['Spotted on sale at 10:02']);
    expect(alertDetails(concert, 'on_sale', at('2026-10-09T12:05:00Z'))).toEqual([]);
    expect(alertDetails(concert, 'sold_out', at('2026-10-09T08:05:00Z'))).toEqual([]);
  });
});

describe('runTicketAlertsSerially', () => {
  it('runs one pass at a time, so two callers cannot send the same news twice', async () => {
    let inFlight = 0;
    let most = 0;
    prisma.concertFollow.findMany.mockImplementation(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return [];
    });

    await Promise.all([runTicketAlertsSerially({ now: NOW }), runTicketAlertsSerially({ now: NOW })]);

    expect(prisma.concertFollow.findMany).toHaveBeenCalledTimes(2);
    expect(most).toBe(1);
  });

  it('keeps going after a pass that failed', async () => {
    prisma.concertFollow.findMany.mockRejectedValueOnce(new Error('database away')).mockResolvedValue([]);

    await expect(runTicketAlertsSerially({ now: NOW })).rejects.toThrow('database away');
    await expect(runTicketAlertsSerially({ now: NOW })).resolves.toMatchObject({ follows: 0 });
  });
});
