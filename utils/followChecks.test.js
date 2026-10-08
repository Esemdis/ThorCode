import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { installFakePrisma } from '../test/routeApp.js';

// ticketAlerts.js, which this reads the sale's opening from, loads the client.
installFakePrisma({});
const require = createRequire(import.meta.url);
const { checkDue, checkEvery, checkTarget, checkUpdate, cleanVendors, hotWindow } = require('./followChecks.js');

const minutes = (n) => n * 60 * 1000;
// A sale on 9 October, the day alone: assumed to open at ten, Berlin time,
// which is 08:00 UTC in summer time. The fives start an hour before.
const saleDay = { on_sale: false, sold_out: false, ticket_sale_start: new Date('2026-10-09T00:00:00Z') };
const at = (iso) => new Date(iso);

describe('hotWindow', () => {
  it('runs from an hour before the assumed opening to the end of the sale day', () => {
    expect(hotWindow(saleDay, at('2026-10-09T06:59:00Z'))).toBeNull();
    expect(hotWindow(saleDay, at('2026-10-09T07:00:00Z'))).toEqual({
      from: at('2026-10-09T07:00:00Z'),
      // Midnight in Berlin.
      until: at('2026-10-09T22:00:00Z'),
    });
    expect(hotWindow(saleDay, at('2026-10-09T21:59:00Z'))).not.toBeNull();
    expect(hotWindow(saleDay, at('2026-10-09T22:00:00Z'))).toBeNull();
  });

  it('starts an hour before a time it was actually given', () => {
    const timed = { ...saleDay, ticket_sale_start: new Date('2026-10-09T16:00:00Z') };
    expect(hotWindow(timed, at('2026-10-09T14:59:00Z'))).toBeNull();
    expect(hotWindow(timed, at('2026-10-09T15:00:00Z'))).not.toBeNull();
  });

  it('is over the moment tickets are selling, and never for a show that is off', () => {
    expect(hotWindow({ ...saleDay, on_sale: true }, at('2026-10-09T08:05:00Z'))).toBeNull();
    expect(hotWindow({ ...saleDay, event_status: 'cancelled' }, at('2026-10-09T08:05:00Z'))).toBeNull();
    expect(hotWindow({ on_sale: false }, at('2026-10-09T08:05:00Z'))).toBeNull();
  });
});

describe('checkDue', () => {
  const read = (iso, over = {}) => ({ ...saleDay, ticket_check_attempted_at: at(iso), ...over });

  it('checks a show never read straight away', () => {
    expect(checkDue({ ...saleDay }, at('2026-10-01T12:00:00Z'))).toMatchObject({ due: true, requested: false });
  });

  it('reads a show every half hour, with room for the tick it lands on', () => {
    const was = read('2026-10-01T12:00:20Z');
    expect(checkDue(was, at('2026-10-01T12:25:00Z')).due).toBe(false);
    // The 12:30 tick, not the 12:35 one.
    expect(checkDue(was, at('2026-10-01T12:30:00Z')).due).toBe(true);
    expect(checkEvery(was, at('2026-10-01T12:30:00Z'))).toBe(30);
  });

  it('reads it every five minutes on the morning the sale opens', () => {
    const was = read('2026-10-09T07:55:10Z');
    expect(checkDue(was, at('2026-10-09T08:00:00Z'))).toMatchObject({ due: true, hot: true });
    expect(checkDue(was, at('2026-10-09T07:57:00Z')).due).toBe(false);
  });

  it('checks straight away when asked, whatever the cadence', () => {
    const asked = read('2026-10-01T12:00:00Z', { ticket_check_requested_at: at('2026-10-01T12:03:00Z') });
    expect(checkDue(asked, at('2026-10-01T12:05:00Z'))).toMatchObject({ due: true, requested: true });
    // Answered: the read after the request is the one it asked for.
    const answered = read('2026-10-01T12:05:00Z', { ticket_check_requested_at: at('2026-10-01T12:03:00Z') });
    expect(checkDue(answered, at('2026-10-01T12:06:00Z'))).toMatchObject({ due: false, requested: false });
  });

  it('backs off a listing that keeps failing, but not on its sale morning', () => {
    const failing = (n) => ({ ticket_check_failures: n });
    const now = at('2026-10-01T12:00:00Z');
    expect(checkEvery(failing(2), now)).toBe(30);
    expect(checkEvery(failing(3), now)).toBe(60);
    expect(checkEvery(failing(4), now)).toBe(120);
    expect(checkEvery(failing(20), now)).toBe(360);
    expect(checkEvery({ ...saleDay, ...failing(20) }, at('2026-10-09T08:00:00Z'))).toBe(5);
  });
});

describe('checkTarget', () => {
  it('reads a Songkick listing where the row has one, festivals included', () => {
    expect(checkTarget({ url: 'https://www.songkick.com/festivals/3808399/id/43451188?utm=x', event_id: 'sk_43451188' }))
      .toEqual({ source: 'songkick', url: 'https://www.songkick.com/festivals/3808399/id/43451188' });
    expect(checkTarget({ url: 'https://www.ticketmaster.se/x', event_id: 'sk_42' }))
      .toEqual({ source: 'songkick', url: 'https://www.songkick.com/concerts/42' });
  });

  it('prefers Songkick to Bandsintown, whose listings all say in stock', () => {
    // A row Bandsintown made and Songkick later filled the time of.
    expect(checkTarget({ url: 'https://www.songkick.com/concerts/42-opeth', event_id: 'bit_9' }).source).toBe('songkick');
    expect(checkTarget({ url: 'https://www.bandsintown.com/t/9', event_id: 'bit_9' }))
      .toEqual({ source: 'bandsintown', url: 'https://www.bandsintown.com/e/9' });
  });

  it('has nothing to read for a show with no listing it knows', () => {
    expect(checkTarget({ url: null, event_id: null })).toBeNull();
    expect(checkTarget({ url: 'http://www.songkick.com/concerts/1', event_id: 'sk_abcdef123456' })).toBeNull();
    expect(checkTarget({ url: 'https://evil.test/www.songkick.com/concerts/1', event_id: null })).toBeNull();
    expect(checkTarget({ url: 'not a url', event_id: 'bit_abc' })).toBeNull();
  });
});

describe('cleanVendors', () => {
  it('keeps what the app shows, and only links that are links', () => {
    expect(cleanVendors([
      { name: ' Ticketmaster ', state: 'on_sale', url: 'https://www.ticketmaster.se/1', price: '€45', extra: 'x' },
      { name: 'AXS', state: 'whatever', sale_date: '9 Oct', url: 'javascript:alert(1)' },
      { url: 'https://www.eventim.de/e/2', state: 'on_sale_soon', sale_date: '2026-10-09' },
      { name: null, state: 'on_sale', url: 'https://www.songkick.com/tickets/9' },
      null, 'x', {},
    ])).toEqual([
      { name: 'Ticketmaster', state: 'on_sale', sale_date: null, url: 'https://www.ticketmaster.se/1', price: '€45' },
      { name: 'AXS', state: 'unknown', sale_date: null, url: null, price: null },
      { name: 'eventim.de', state: 'on_sale_soon', sale_date: '2026-10-09', url: 'https://www.eventim.de/e/2', price: null },
      // Songkick's own redirect names nobody: not "songkick.com" as a vendor.
      { name: 'Tickets', state: 'on_sale', sale_date: null, url: 'https://www.songkick.com/tickets/9', price: null },
    ]);
    expect(cleanVendors(undefined)).toBeNull();
    expect(cleanVendors([])).toEqual([]);
  });
});

describe('checkUpdate', () => {
  const NOW = at('2026-10-09T08:02:00Z');
  const stored = (over = {}) => ({
    id: 300, name: 'Hollywood Undead: EU/UK 2027', venue: 'Fållan', latitude: '59.30', longitude: '18.08',
    concert_date: at('2027-02-13T18:45:00Z'), source: 'songkick', metadata: JSON.stringify(['Hollywood Undead']),
    festival: false, on_sale: false, sold_out: false, ticket_sale_start: at('2026-10-09T00:00:00Z'),
    price_min: null, price_max: null, price_currency: null, ticket_vendors: null, event_status: null, ...over,
  });
  const check = (concert = {}, extra = {}) => ({ concert_id: 300, ok: true, concert: { source: 'songkick', ...concert }, ...extra });

  it('records a sale opening, and the minute it was seen to', () => {
    expect(checkUpdate(stored(), check({ on_sale: true, sold_out: false }), NOW))
      .toEqual({ on_sale: true, tickets_opened_at: NOW });
  });

  it('dates no opening for a show nobody knew was not selling', () => {
    const unknown = stored({ ticket_sale_start: null });
    expect(checkUpdate(unknown, check({ on_sale: true, sold_out: false }), NOW)).toEqual({ on_sale: true });
  });

  it('holds the checker to the full sync\'s rules for a listing in stock by default', () => {
    // A sale day still ahead is not undone by a bare "in stock".
    const ahead = stored({ ticket_sale_start: at('2026-10-11T00:00:00Z') });
    expect(checkUpdate(ahead, check({ on_sale: true, sold_out: false }), NOW)).toEqual({});
  });

  it('stores who sells it, the price and the bill, and only what is new', () => {
    const vendors = [{ name: 'Ticketmaster', state: 'on_sale_soon', sale_date: '2026-10-09', url: 'https://www.ticketmaster.se/1' }];
    const update = checkUpdate(stored(), check({
      price_min: 45, price_max: 89, price_currency: 'EUR',
      metadata: JSON.stringify(['Hollywood Undead', 'Ghost']),
    }, { vendors }), NOW);

    expect(update).toEqual({
      price_min: 45, price_max: 89, price_currency: 'EUR',
      metadata: JSON.stringify(['Hollywood Undead', 'Ghost']),
      ticket_vendors: [{ ...vendors[0], price: null }],
    });
    const again = stored({ ticket_vendors: update.ticket_vendors });
    expect(checkUpdate(again, check({}, { vendors })).ticket_vendors).toBeUndefined();
  });

  it('follows a show to another day and another room, never to another link', () => {
    const update = checkUpdate(stored(), check({
      concert_date: '2027-03-14T18:45:00', venue: 'Annexet', latitude: '59.29', longitude: '18.10',
      url: 'https://elsewhere.test/',
    }), NOW);

    expect(update).toMatchObject({ concert_date: at('2027-03-14T18:45:00'), venue: 'Annexet' });
    expect(update).not.toHaveProperty('url');
  });

  it('records a show off or postponed, and back on', () => {
    expect(checkUpdate(stored(), check({}, { event_status: 'cancelled' }), NOW)).toEqual({ event_status: 'cancelled' });
    expect(checkUpdate(stored({ event_status: 'postponed' }), check({}, { event_status: 'rescheduled' }), NOW))
      .toEqual({ event_status: null });
    // A listing that says nothing either way leaves it be.
    expect(checkUpdate(stored({ event_status: 'postponed' }), check({}, { event_status: null }), NOW)).toEqual({});
    expect(checkUpdate(stored(), check({}, { event_status: 'EventMovedOnline' }), NOW)).toEqual({});
  });
});
