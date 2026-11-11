import { describe, it, expect } from 'vitest';
import {
  listingUrl, isHot, checkDue, dueChecks, checkView, checkable, sanitizeVendors, checkedFields, readTime,
} from './followCheck.js';

const NOW_THO779 = new Date('2026-11-11T09:00:00Z');
const minutesAgoTho779 = (n, now = NOW_THO779) => new Date(now.getTime() - n * 60 * 1000);

// A Songkick show still to come, with nothing known about its tickets.
const followedShowTho779 = (over = {}) => ({
  id: 300,
  url: 'https://www.songkick.com/concerts/42938629-opeth-at-fallan',
  event_id: 'sk_42938629',
  source: 'songkick',
  concert_date: new Date('2027-02-13T18:45:00Z'),
  on_sale: false,
  sold_out: false,
  ticket_sale_start: null,
  price_min: null,
  price_max: null,
  price_currency: null,
  vendors: null,
  event_status: null,
  tickets_opened_at: null,
  ...over,
});

describe('which page a followed show is read from', () => {
  it('reads the stored Songkick url, without the query string a link picked up', () => {
    expect(listingUrl({ url: 'https://www.songkick.com/concerts/1-x?utm_source=calendar' }))
      .toBe('https://www.songkick.com/concerts/1-x');
  });

  it('builds the page from the Songkick id when Bandsintown owns the url', () => {
    expect(listingUrl({ url: 'https://www.bandsintown.com/e/1', event_id: 'sk_42938629' }))
      .toBe('https://www.songkick.com/concerts/42938629');
  });

  it('has none for a Bandsintown-only show, or a hashed id that names no page', () => {
    expect(listingUrl({ url: 'https://www.bandsintown.com/e/1', event_id: 'bit_1' })).toBeNull();
    // sk_ and hex is the fallback id for a listing with no number in it.
    expect(listingUrl({ url: null, event_id: 'sk_3f2a9c0b11de' })).toBeNull();
  });

  it('refuses a url that only mentions songkick.com, and plain http', () => {
    expect(listingUrl({ url: 'https://evil.example/?ref=songkick.com' })).toBeNull();
    expect(listingUrl({ url: 'https://songkick.com.evil.example/concerts/1' })).toBeNull();
    expect(listingUrl({ url: 'http://www.songkick.com/concerts/1-x' })).toBeNull();
  });
});

describe('when a sale is close enough to read every five minutes', () => {
  it('is hot from an hour before a sale with a time until two hours after', () => {
    const show = followedShowTho779({ ticket_sale_start: new Date('2026-11-11T10:00:00Z') });
    expect(isHot(show, new Date('2026-11-11T08:59:00Z'))).toBe(false);
    expect(isHot(show, new Date('2026-11-11T09:00:00Z'))).toBe(true);
    expect(isHot(show, new Date('2026-11-11T12:00:00Z'))).toBe(true);
    expect(isHot(show, new Date('2026-11-11T12:01:00Z'))).toBe(false);
  });

  it('is hot from 06:00 to 12:00 UTC on the day of a sale known only by its day', () => {
    // Midnight UTC is how a day-only sale is stored. The window is 07:00-13:00
    // in Stockholm in winter and 08:00-14:00 in summer: both hold a 10:00 sale.
    const show = followedShowTho779({ ticket_sale_start: new Date('2026-11-11T00:00:00Z') });
    expect(isHot(show, new Date('2026-11-11T05:59:00Z'))).toBe(false);
    expect(isHot(show, new Date('2026-11-11T06:00:00Z'))).toBe(true);
    expect(isHot(show, new Date('2026-11-11T11:59:00Z'))).toBe(true);
    expect(isHot(show, new Date('2026-11-11T12:00:00Z'))).toBe(false);
    expect(isHot(show, new Date('2026-11-10T09:00:00Z'))).toBe(false);
  });

  it('is not hot once the tickets are on sale or sold out', () => {
    const sale = new Date('2026-11-11T00:00:00Z');
    expect(isHot(followedShowTho779({ ticket_sale_start: sale, on_sale: true }), NOW_THO779)).toBe(false);
    expect(isHot(followedShowTho779({ ticket_sale_start: sale, sold_out: true }), NOW_THO779)).toBe(false);
    expect(isHot(followedShowTho779(), NOW_THO779)).toBe(false);
  });
});

describe('when a followed show is due a read', () => {
  it('is due every half hour, measured a minute short so a five-minute tick does not skip one', () => {
    const show = followedShowTho779();
    expect(checkDue(show, null, NOW_THO779)).toBe('never');
    expect(checkDue(show, { attempted_at: minutesAgoTho779(28) }, NOW_THO779)).toBeNull();
    expect(checkDue(show, { attempted_at: minutesAgoTho779(29) }, NOW_THO779)).toBe('stale');
  });

  it('is due every five minutes while hot', () => {
    const show = followedShowTho779({ ticket_sale_start: new Date('2026-11-11T00:00:00Z') });
    expect(checkDue(show, { attempted_at: minutesAgoTho779(3) }, NOW_THO779)).toBeNull();
    // Four minutes and some seconds after the last tick's read is the next tick.
    expect(checkDue(show, { attempted_at: minutesAgoTho779(4.5) }, NOW_THO779)).toBe('hot');
  });

  it('is due at once when someone asked and nothing has been tried since', () => {
    const show = followedShowTho779();
    expect(checkDue(show, { attempted_at: minutesAgoTho779(10), requested_at: minutesAgoTho779(1) }, NOW_THO779)).toBe('requested');
    expect(checkDue(show, { attempted_at: minutesAgoTho779(1), requested_at: minutesAgoTho779(10) }, NOW_THO779)).toBeNull();
  });

  it('measures from the last attempt, so a listing that will not load is not tried every tick', () => {
    const show = followedShowTho779();
    expect(checkDue(show, { checked_at: minutesAgoTho779(600), attempted_at: minutesAgoTho779(5) }, NOW_THO779)).toBeNull();
  });

  it('is never due for a show already been, or one with no listing', () => {
    expect(checkDue(followedShowTho779({ concert_date: new Date('2026-11-10T19:00:00Z') }), null, NOW_THO779)).toBeNull();
    expect(checkDue(followedShowTho779({ url: null, event_id: 'bit_1' }), null, NOW_THO779)).toBeNull();
    // Tonight's show is still to come.
    expect(checkDue(followedShowTho779({ concert_date: new Date('2026-11-11T19:00:00Z') }), null, NOW_THO779)).toBe('never');
  });
});

describe('the order a tick reads them in', () => {
  const rowsTho779 = [
    { concert: followedShowTho779({ id: 1 }), check: { attempted_at: minutesAgoTho779(40) } },
    { concert: followedShowTho779({ id: 2 }), check: { attempted_at: minutesAgoTho779(90) } },
    { concert: followedShowTho779({ id: 3 }), check: null },
    { concert: followedShowTho779({ id: 4, ticket_sale_start: new Date('2026-11-11T00:00:00Z') }), check: { attempted_at: minutesAgoTho779(6) } },
    { concert: followedShowTho779({ id: 5 }), check: { attempted_at: minutesAgoTho779(10), requested_at: minutesAgoTho779(1) } },
    { concert: followedShowTho779({ id: 6 }), check: { attempted_at: minutesAgoTho779(1) } },
  ];

  it('puts asked-for first, then a sale opening, then never read, then the stalest', () => {
    expect(dueChecks(rowsTho779, { now: NOW_THO779 }).map((d) => [d.concert_id, d.reason])).toEqual([
      [5, 'requested'], [4, 'hot'], [3, 'never'], [2, 'stale'], [1, 'stale'],
    ]);
  });

  it('keeps to the limit, and only what cannot wait while a full sync has Songkick open', () => {
    expect(dueChecks(rowsTho779, { now: NOW_THO779, limit: 2 }).map((d) => d.concert_id)).toEqual([5, 4]);
    expect(dueChecks(rowsTho779, { now: NOW_THO779, busy: true }).map((d) => d.concert_id)).toEqual([5, 4]);
  });

  it('hands over the page to read', () => {
    expect(dueChecks(rowsTho779, { now: NOW_THO779 })[0].url).toBe('https://www.songkick.com/concerts/42938629-opeth-at-fallan');
  });
});

describe('what a follower is told about the checker', () => {
  it('is null for a show with no listing, so no "Check now" is offered', () => {
    expect(checkView(followedShowTho779({ url: null, event_id: null }), null, NOW_THO779)).toBeNull();
  });

  it('says when it was last read, whether one is on its way, hot, and failing after two misses', () => {
    const checkedAt = minutesAgoTho779(12);
    expect(checkView(followedShowTho779(), { checked_at: checkedAt, attempted_at: checkedAt, failures: 1 }, NOW_THO779))
      .toEqual({ checked_at: checkedAt, pending: false, hot: false, failing: false });
    expect(checkView(
      followedShowTho779({ ticket_sale_start: new Date('2026-11-11T00:00:00Z') }),
      { checked_at: null, attempted_at: minutesAgoTho779(3), requested_at: minutesAgoTho779(1), failures: 2 },
      NOW_THO779,
    )).toEqual({ checked_at: null, pending: true, hot: true, failing: true });
  });

  it('asks again only past the two-minute guard, but counts one already waiting', () => {
    const show = followedShowTho779();
    expect(checkable(show, { attempted_at: minutesAgoTho779(1) }, NOW_THO779)).toBe(false);
    expect(checkable(show, { attempted_at: minutesAgoTho779(3) }, NOW_THO779)).toBe(true);
    expect(checkable(show, { attempted_at: minutesAgoTho779(1), requested_at: minutesAgoTho779(0.5) }, NOW_THO779)).toBe(true);
    expect(checkable(followedShowTho779({ concert_date: new Date('2026-01-01') }), null, NOW_THO779)).toBe(false);
  });
});

describe('vendor rows as they are stored', () => {
  it('keeps name, link, state, sale day and price, and drops a link that is not http(s)', () => {
    expect(sanitizeVendors([
      { name: ' Ticketmaster ', url: 'https://www.ticketmaster.se/event/1', state: 'on_sale', sale_date: null, price: '€45' },
      // concert-map puts this url in an href.
      { name: 'Evil', url: 'javascript:alert(1)', state: 'on_sale_soon', sale_date: '2026-11-20', price: null },
    ])).toEqual([
      { name: 'Ticketmaster', url: 'https://www.ticketmaster.se/event/1', state: 'on_sale', sale_date: null, price: '€45' },
      { name: 'Evil', url: null, state: 'on_sale_soon', sale_date: '2026-11-20', price: null },
    ]);
  });

  it('reads an unknown state as unknown, a malformed day or long price as none, and skips rows with nothing', () => {
    expect(sanitizeVendors([
      { name: 'AXS', state: 'flying', sale_date: '20 Nov', price: 'x'.repeat(31) },
      { name: '', url: '' },
      'not a row',
    ])).toEqual([{ name: 'AXS', url: null, state: 'unknown', sale_date: null, price: null }]);
  });

  it('keeps at most twenty, with names cut at eighty characters', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `${'V'.repeat(90)}${i}` }));
    const kept = sanitizeVendors(many);
    expect(kept).toHaveLength(20);
    expect(kept[0].name).toHaveLength(80);
    expect(sanitizeVendors('nope')).toEqual([]);
  });
});

describe('what a successful read writes onto the show', () => {
  const readTho779 = (over = {}) => ({
    concert_id: 300, ok: true, on_sale: null, sold_out: false, ticket_sale_start: null,
    price_min: null, price_max: null, price_currency: null, vendors: [], event_status: null, ...over,
  });

  it('records a sale day the page names, with its own "not on sale yet"', () => {
    const fields = checkedFields(followedShowTho779({ on_sale: true }), readTho779({ on_sale: false, ticket_sale_start: '2026-11-20' }), NOW_THO779);
    expect(fields).toMatchObject({ ticket_sale_start: new Date('2026-11-20T00:00:00Z'), on_sale: false });
  });

  it('never clears a sale day still ahead with an in-stock default', () => {
    // Both scrapers mark a listing in stock by default; mergeTicketFields is
    // what keeps that from overwriting a day another read found.
    const stored = followedShowTho779({ ticket_sale_start: new Date('2026-11-20T00:00:00Z') });
    expect(checkedFields(stored, readTho779({ on_sale: true }), NOW_THO779)).not.toHaveProperty('on_sale');
    expect(checkedFields(stored, readTho779({ on_sale: true }), NOW_THO779)).not.toHaveProperty('ticket_sale_start');
  });

  it('stamps when a sale it was waiting on opened, once, and keeps it if the page goes back to "soon"', () => {
    const waiting = followedShowTho779({ ticket_sale_start: new Date('2026-11-11T00:00:00Z') });
    const opened = checkedFields(waiting, readTho779({ on_sale: true }), NOW_THO779);
    expect(opened).toMatchObject({ on_sale: true, tickets_opened_at: NOW_THO779 });

    const later = new Date('2026-11-11T09:30:00Z');
    const stamped = { ...waiting, ...opened };
    expect(checkedFields(stamped, readTho779({ on_sale: true }), later)).not.toHaveProperty('tickets_opened_at');
    expect(checkedFields(stamped, readTho779({ on_sale: false, ticket_sale_start: '2026-11-12' }), later))
      .not.toHaveProperty('tickets_opened_at');
  });

  it('does not stamp a show that was already on sale, or came back from sold out', () => {
    // "opened 09:00" would be the time of the read, not of the sale.
    expect(checkedFields(followedShowTho779({ on_sale: true }), readTho779({ on_sale: true }), NOW_THO779))
      .not.toHaveProperty('tickets_opened_at');
    expect(checkedFields(followedShowTho779({ on_sale: false }), readTho779({ on_sale: true }), NOW_THO779))
      .not.toHaveProperty('tickets_opened_at');
    const soldOut = followedShowTho779({ sold_out: true, ticket_sale_start: new Date('2026-10-01T00:00:00Z') });
    expect(checkedFields(soldOut, readTho779({ on_sale: true, sold_out: false }), NOW_THO779))
      .not.toHaveProperty('tickets_opened_at');
  });

  it('does not stamp a sale whose day passed weeks before the read that first saw it on sale', () => {
    // THO-907: a past sale day with on_sale still false reads as "unknown"
    // (the full sync never flipped the flag), and stamping it gave a sale that
    // opened on 20 Oct "opened 15:00, 11 Nov", the time of the read.
    const pastSaleTho907 = followedShowTho779({ ticket_sale_start: new Date('2026-10-20T00:00:00Z') });
    const readAtTho907 = new Date('2026-11-11T15:00:00Z');
    const fields = checkedFields(pastSaleTho907, readTho779({ on_sale: true }), readAtTho907);
    expect(fields).toMatchObject({ on_sale: true });
    expect(fields).not.toHaveProperty('tickets_opened_at');
  });

  it('marks it sold out', () => {
    expect(checkedFields(followedShowTho779({ on_sale: true }), readTho779({ sold_out: true }), NOW_THO779))
      .toMatchObject({ sold_out: true, on_sale: false });
  });

  it('writes the price by the full sync\'s rule: its own listing may change it, another only fill it in', () => {
    expect(checkedFields(followedShowTho779({ price_min: 30, price_currency: 'EUR' }), readTho779({ price_min: 35, price_currency: 'EUR' }), NOW_THO779))
      .toMatchObject({ price_min: 35 });
    const bitRow = followedShowTho779({ source: 'bandsintown', price_min: 30, price_currency: 'EUR' });
    expect(checkedFields(bitRow, readTho779({ price_min: 35, price_currency: 'EUR' }), NOW_THO779)).not.toHaveProperty('price_min');
    // The same price again is no write at all.
    expect(checkedFields(followedShowTho779({ price_min: 30, price_currency: 'EUR', vendors: [] }), readTho779({ price_min: 30, price_currency: 'EUR' }), NOW_THO779))
      .toEqual({});
  });

  it('replaces the vendors when they changed, and leaves them when they did not', () => {
    const vendors = [{ name: 'Eventim', url: 'https://www.eventim.de/x', state: 'on_sale', sale_date: null, price: null }];
    expect(checkedFields(followedShowTho779(), readTho779({ vendors }), NOW_THO779).vendors).toEqual(vendors);
    expect(checkedFields(followedShowTho779({ vendors }), readTho779({ vendors }), NOW_THO779)).not.toHaveProperty('vendors');
    // As Postgres returns jsonb: the same rows with their keys in another order.
    const fromJsonb = [{ url: 'https://www.eventim.de/x', name: 'Eventim', price: null, state: 'on_sale', sale_date: null }];
    expect(checkedFields(followedShowTho779({ vendors: fromJsonb }), readTho779({ vendors }), NOW_THO779)).not.toHaveProperty('vendors');
  });

  it('records a cancellation, and leaves the stored status alone when the page says none', () => {
    expect(checkedFields(followedShowTho779(), readTho779({ event_status: 'cancelled' }), NOW_THO779)).toMatchObject({ event_status: 'cancelled' });
    expect(checkedFields(followedShowTho779({ event_status: 'cancelled' }), readTho779({ event_status: null }), NOW_THO779))
      .not.toHaveProperty('event_status');
    expect(checkedFields(followedShowTho779(), readTho779({ event_status: 'drop table' }), NOW_THO779)).not.toHaveProperty('event_status');
  });

  it('ignores a malformed sale day and a negative price', () => {
    const fields = checkedFields(followedShowTho779(), readTho779({ ticket_sale_start: 'soon', price_min: -1, price_currency: 'EUR' }), NOW_THO779);
    expect(fields).not.toHaveProperty('ticket_sale_start');
    expect(fields).not.toHaveProperty('price_min');
    expect(fields).not.toHaveProperty('price_currency');
  });
});

describe('when a read happened', () => {
  const postedAtTho907 = new Date('2026-11-11T09:10:00Z');

  it('takes the time the sync service read the page, not the time it posted the batch', () => {
    expect(readTime('2026-11-11T09:07:30Z', postedAtTho907)).toEqual(new Date('2026-11-11T09:07:30Z'));
  });

  it('falls back to the post for a read without a time, or one that is not a time', () => {
    expect(readTime(undefined, postedAtTho907)).toEqual(postedAtTho907);
    expect(readTime('soon', postedAtTho907)).toEqual(postedAtTho907);
    expect(readTime(1731316000000, postedAtTho907)).toEqual(postedAtTho907);
  });

  it('never puts a read in the future, nor further back than a tick could take', () => {
    // A fast clock on the sync service must not make "Checked" lie ahead of
    // now; a slow one is a wrong clock, not a slow tick, and is held at 15 min.
    expect(readTime('2026-11-11T09:20:00Z', postedAtTho907)).toEqual(postedAtTho907);
    expect(readTime('2026-11-11T07:00:00Z', postedAtTho907)).toEqual(new Date('2026-11-11T08:55:00Z'));
  });
});
