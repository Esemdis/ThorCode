import { describe, it, expect } from 'vitest';
import { concertEventFields, concertToIcs, concertsToIcs, icsFilename, foldIcsLine, storesRealInstant } from './ics.js';

const NOW = new Date('2026-08-17T09:30:00.000Z');

const concert = (over = {}) => ({
  id: 42,
  name: 'Slipknot',
  band: 'Slipknot',
  concert_date: '2026-09-12T00:00:00.000Z',
  venue: 'Oslo Spektrum',
  city: 'Oslo',
  country: 'NO',
  ...over,
});

describe('concertEventFields', () => {
  it('titles the event with the event name, falling back to the band', () => {
    expect(concertEventFields(concert()).title).toBe('Slipknot');
    expect(concertEventFields(concert({ name: 'Tons of Rock' })).title).toBe('Tons of Rock');
    expect(concertEventFields(concert({ name: null })).title).toBe('Slipknot');
    expect(concertEventFields(concert({ name: null, band: null })).title).toBe('Concert');
  });

  it('joins venue, city and country into one location line', () => {
    expect(concertEventFields(concert()).location).toBe('Oslo Spektrum, Oslo, Norway');
  });

  it('leaves out the parts of the location the concert does not have', () => {
    expect(concertEventFields(concert({ venue: null })).location).toBe('Oslo, Norway');
    expect(concertEventFields(concert({ country: null })).location).toBe('Oslo Spektrum, Oslo');
    expect(concertEventFields(concert({ venue: null, city: null, country: null })).location).toBe('');
  });

  it('keeps an unrecognised country code rather than dropping the line', () => {
    expect(concertEventFields(concert({ country: 'Unknown country' })).location)
      .toBe('Oslo Spektrum, Oslo, Unknown country');
  });

  it('lists every band playing, from both lineup sources', () => {
    const fields = concertEventFields(concert({
      participating_bands: [{ name: 'Slipknot' }],
      metadata: '["Vended","Bleed From Within"]',
    }));
    expect(fields.description).toContain('Playing: Slipknot, Vended, Bleed From Within');
  });

  it('does not name a band twice when it appears in both lineup sources', () => {
    // concertLineup already de-duplicates, including across the scraper's
    // "Slipknot266K Followers" spelling — this pins that the blurb uses it.
    const fields = concertEventFields(concert({
      participating_bands: [{ name: 'Slipknot' }],
      metadata: '["Slipknot266K Followers","Vended"]',
    }));
    expect(fields.description).toContain('Playing: Slipknot, Vended');
  });

  it('leaves out the lineup line when no bands are known', () => {
    const fields = concertEventFields(concert({ participating_bands: [], metadata: null }));
    expect(fields.description).not.toContain('Playing:');
  });

  it('quotes a price range, and a single price as a floor', () => {
    expect(concertEventFields(concert({ price_min: 450, price_currency: 'NOK' })).description)
      .toContain('Tickets from 450 NOK');
    expect(concertEventFields(concert({ price_min: 450, price_max: 800, price_currency: 'NOK' })).description)
      .toContain('Tickets 450–800 NOK');
  });

  it('includes the ticket link', () => {
    expect(concertEventFields(concert({ url: 'https://tickets.example/1' })).description)
      .toContain('https://tickets.example/1');
  });

  it('makes a concert with no scraped start time an all-day event', () => {
    // Shows scraped without a time land on exactly 00:00Z. Giving those a
    // fabricated evening slot would put a wrong time in the calendar for most
    // of the list, so they stay all-day.
    const fields = concertEventFields(concert());
    expect(fields.allDay).toBe(true);
    expect(fields.start).toBe('20260912');
  });

  it('ends an all-day event on the following day', () => {
    // An iCalendar all-day DTEND is exclusive: ending on the 12th would render
    // the show as a zero-length event, or drop it entirely.
    expect(concertEventFields(concert()).end).toBe('20260913');
  });

  it('keeps a real start time and gives the show a three-hour slot', () => {
    const fields = concertEventFields(concert({ concert_date: '2026-09-12T19:00:00.000Z' }));
    expect(fields.allDay).toBe(false);
    expect(fields.start).toBe('20260912T190000');
    expect(fields.end).toBe('20260912T220000');
  });

  it('writes the start time as a wall clock rather than an instant', () => {
    // The Z on concert_date does not mean the time is really UTC. Songkick's
    // startDate usually carries no zone, and the scraper stamps those naive
    // local times with UTC, so 19:00 at an Oslo venue is stored as 19:00Z.
    // Read as an instant that lands in the calendar as 21:00. An iCalendar
    // date-time with no Z and no TZID is "floating" — it shows as 19:00 in
    // whatever zone the calendar is opened in, which is the wall clock the
    // venue actually posted.
    const fields = concertEventFields(concert({ concert_date: '2026-09-12T19:00:00.000Z' }));
    expect(fields.start).not.toContain('Z');
    expect(fields.end).not.toContain('Z');
  });

  it('rolls a late show onto the next day when its slot crosses midnight', () => {
    const fields = concertEventFields(concert({ concert_date: '2026-09-12T23:30:00.000Z' }));
    expect(fields.start).toBe('20260912T233000');
    expect(fields.end).toBe('20260913T023000');
  });

  it('returns null for a concert with no date', () => {
    expect(concertEventFields(concert({ concert_date: null }))).toBeNull();
  });
});

describe('foldIcsLine', () => {
  it('leaves a line of 75 octets or fewer alone', () => {
    const line = `SUMMARY:${'a'.repeat(67)}`;
    expect(line).toHaveLength(75);
    expect(foldIcsLine(line)).toBe(line);
  });

  it('folds a longer line onto continuation lines beginning with a space', () => {
    const folded = foldIcsLine(`DESCRIPTION:${'a'.repeat(200)}`).split('\r\n');
    expect(folded.length).toBeGreaterThan(1);
    expect(folded.every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(folded.slice(1).every((l) => l.startsWith(' '))).toBe(true);
  });

  it('unfolds back to exactly the original line', () => {
    const line = `DESCRIPTION:${'Playing: Slipknot, Vended, Bleed From Within, '.repeat(6)}`;
    const unfolded = foldIcsLine(line).split('\r\n').map((l, i) => (i ? l.slice(1) : l)).join('');
    expect(unfolded).toBe(line);
  });

  it('never splits a multi-byte character across two lines', () => {
    // Folding is measured in octets, not characters. Slicing by character
    // count overflows the limit; slicing the encoded bytes would cut "ö" in
    // half and produce a corrupt file.
    const folded = foldIcsLine(`SUMMARY:${'ö'.repeat(120)}`).split('\r\n');
    expect(folded.every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(folded.join('')).not.toContain('�');
    const unfolded = folded.map((l, i) => (i ? l.slice(1) : l)).join('');
    expect(unfolded).toBe(`SUMMARY:${'ö'.repeat(120)}`);
  });
});

describe('concertToIcs', () => {
  it('wraps the event in a calendar the spec requires a version and product id on', () => {
    const ics = concertToIcs(concert(), NOW);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('PRODID:');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VEVENT');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('separates every line with CRLF', () => {
    // RFC 5545 requires CRLF. Outlook rejects a file that uses bare newlines.
    const ics = concertToIcs(concert(), NOW);
    expect(ics.split('\n').every((l) => l === '' || l.endsWith('\r'))).toBe(true);
  });

  it('writes an all-day show as DATE values rather than timestamps', () => {
    const ics = concertToIcs(concert(), NOW);
    expect(ics).toContain('DTSTART;VALUE=DATE:20260912');
    expect(ics).toContain('DTEND;VALUE=DATE:20260913');
  });

  it('writes a show with a known time as a floating local timestamp', () => {
    const ics = concertToIcs(concert({ concert_date: '2026-09-12T19:00:00.000Z' }), NOW);
    expect(ics).toContain('DTSTART:20260912T190000\r\n');
    expect(ics).toContain('DTEND:20260912T220000\r\n');
  });

  it('still stamps DTSTAMP in UTC, which the spec requires', () => {
    // DTSTAMP is a real instant — when the file was made — unlike the event
    // times, which are the venue's wall clock.
    expect(concertToIcs(concert(), NOW)).toContain('DTSTAMP:20260817T093000Z');
  });

  it('stamps the file with the time it was generated', () => {
    expect(concertToIcs(concert(), NOW)).toContain('DTSTAMP:20260817T093000Z');
  });

  it('derives the UID from the concert id, so re-adding updates the same entry', () => {
    const first = concertToIcs(concert(), NOW);
    const again = concertToIcs(concert(), new Date('2026-08-18T00:00:00.000Z'));
    const uid = (ics) => ics.split('\r\n').find((l) => l.startsWith('UID:'));
    expect(uid(first)).toBe(uid(again));
    expect(uid(first)).toContain('42');
  });

  it('escapes the characters iCalendar gives its own meaning to', () => {
    // Unescaped, a comma in a venue name splits the property into two values
    // and the rest of the address disappears from the calendar entry.
    const ics = concertToIcs(concert({ venue: 'Rockefeller, Oslo; back room \\ annex' }), NOW);
    expect(ics).toContain('Rockefeller\\, Oslo\\; back room \\\\ annex');
  });

  it('writes newlines in the blurb as escaped breaks, not real line breaks', () => {
    const ics = concertToIcs(concert({
      participating_bands: [{ name: 'Slipknot' }],
      url: 'https://tickets.example/1',
    }), NOW);
    const description = ics.split('\r\n').find((l) => l.startsWith('DESCRIPTION:'));
    expect(description).toContain('\\n');
  });

  it('keeps every line inside the 75-octet limit', () => {
    const ics = concertToIcs(concert({
      metadata: JSON.stringify(Array.from({ length: 30 }, (_, i) => `Band Number ${i}`)),
    }), NOW);
    expect(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  });

  it('returns null for a concert with no date', () => {
    expect(concertToIcs(concert({ concert_date: null }), NOW)).toBeNull();
  });
});

describe('icsFilename', () => {
  it('names the file after the date and the event', () => {
    expect(icsFilename(concert())).toBe('2026-09-12-slipknot.ics');
  });

  it('replaces characters that are awkward in a filename', () => {
    expect(icsFilename(concert({ name: 'Rock am Ring / Rock im Park' })))
      .toBe('2026-09-12-rock-am-ring-rock-im-park.ics');
  });

  it('still produces a usable name when the concert has no date or title', () => {
    expect(icsFilename(concert({ concert_date: null, name: null, band: null }))).toBe('concert.ics');
  });
});

describe('concertsToIcs', () => {
  const other = () => concert({
    id: 77,
    name: 'Architects',
    concert_date: '2026-10-02T00:00:00.000Z',
    venue: 'Annexet',
    city: 'Stockholm',
    country: 'SE',
  });

  it('puts every concert in one calendar', () => {
    const ics = concertsToIcs([concert(), other()], NOW);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics.match(/BEGIN:VCALENDAR/g)).toHaveLength(1);
    expect(ics).toContain('SUMMARY:Slipknot');
    expect(ics).toContain('SUMMARY:Architects');
  });

  it('gives each concert the same UID it gets on its own', () => {
    // The feed is re-fetched on every poll. Matching UIDs are what make a
    // refresh update the existing entries instead of adding a second copy of
    // every concert each time.
    const single = concertToIcs(concert(), NOW);
    const feed = concertsToIcs([concert(), other()], NOW);
    const uid = single.split('\r\n').find((l) => l.startsWith('UID:'));
    expect(feed).toContain(uid);
  });

  it('skips a concert with no date rather than dropping the whole feed', () => {
    const ics = concertsToIcs([concert(), concert({ id: 5, concert_date: null })], NOW);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it('is still a valid calendar when you are going to nothing', () => {
    // An empty feed is a calendar with no events, not an error. A subscriber
    // who unmarks their last concert should see it empty, not broken.
    const ics = concertsToIcs([], NOW);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('folds long lines in a feed just as it does in a single event', () => {
    const ics = concertsToIcs([concert({
      metadata: JSON.stringify(Array.from({ length: 30 }, (_, i) => `Band Number ${i}`)),
    })], NOW);
    expect(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  });
});

describe('storesRealInstant', () => {
  it('says Songkick rows already hold a true UTC instant', () => {
    // Verified against the live pages on 2026-08-27: a Songkick concert whose
    // page reads "Doors open: 20:00" in Cologne is stored as 18:00Z, and one
    // reading 18:00 in Utrecht is stored as 17:00Z. Both are correct UTC.
    expect(storesRealInstant('songkick')).toBe(true);
  });

  it('says the other sources hold a wall clock wearing a Z', () => {
    // Bandsintown's 19:00 Stockholm show is stored as 19:00Z, which as an
    // instant is 20:00 local — an hour out. post_tours.py builds Ticketmaster
    // values as `${localDate}T${localTime}Z` outright.
    expect(storesRealInstant('bandsintown')).toBe(false);
    expect(storesRealInstant('ticketmaster')).toBe(false);
  });

  it('treats an unknown or missing source as a wall clock', () => {
    // 208 rows carry no source and 25 come from setlist.fm; neither has been
    // verified. Floating is the reading that was already shipping, so treating
    // them this way changes nothing rather than guessing in a new direction.
    expect(storesRealInstant(null)).toBe(false);
    expect(storesRealInstant('setlistfm')).toBe(false);
  });
});

describe('concertEventFields — per-source times', () => {
  const at = (source, date) => concertEventFields(concert({ source, concert_date: date }));

  it('writes a Songkick time as an instant, so calendars localise it', () => {
    // 17:00Z is 18:00 in Utrecht. Written floating it would read 17:00 — an
    // hour early — which is what 269 concerts were doing.
    const f = at('songkick', '2026-11-02T17:00:00.000Z');
    expect(f.start).toBe('20261102T170000Z');
    expect(f.end).toBe('20261102T200000Z');
  });

  it('leaves a Bandsintown time floating, because the number is the wall clock', () => {
    const f = at('bandsintown', '2026-11-27T19:00:00.000Z');
    expect(f.start).toBe('20261127T190000');
    expect(f.end).toBe('20261127T220000');
  });

  it('still makes a midnight-stamped concert all-day whatever the source', () => {
    // No time was published; that is true regardless of how the source stores
    // the ones that were.
    expect(at('songkick', '2026-11-02T00:00:00.000Z').allDay).toBe(true);
    expect(at('bandsintown', '2026-11-27T00:00:00.000Z').allDay).toBe(true);
  });
});

describe('concertToIcs — per-source times', () => {
  it('marks a Songkick DTSTART as UTC and a Bandsintown one as floating', () => {
    const sk = concertToIcs(concert({ source: 'songkick', concert_date: '2026-11-02T17:00:00.000Z' }), NOW);
    const bit = concertToIcs(concert({ source: 'bandsintown', concert_date: '2026-11-27T19:00:00.000Z' }), NOW);
    expect(sk).toContain('DTSTART:20261102T170000Z');
    expect(bit).toContain('DTSTART:20261127T190000\r\n');
  });
});
