// iCalendar (RFC 5545) output for concerts, for both the per-concert download
// and the subscribable Going feed.
//
// This is the only implementation. It used to live in the concert-map frontend
// and was moved here when the feed was added: the fiddly parts below — folding,
// escaping, floating time, stable UIDs — are exactly the kind of thing that
// drifts when two copies exist, and a calendar file is unforgiving about all of
// them.

const { cleanLineupNames } = require('./lineupNames');

// Concerts are scraped without a running time, so a show with a real start gets
// a nominal slot rather than a measured one. Three hours covers doors-to-encore
// for a normal bill without blocking out the whole evening.
const EVENT_HOURS = 3;

// RFC 5545 measures a content line in octets, not characters.
const MAX_OCTETS = 75;

const encoder = new TextEncoder();
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

const pad = (n) => String(n).padStart(2, '0');

/** Expand an ISO country code; anything Intl rejects is handed back untouched. */
function countryName(code) {
  if (!code) return code;
  try { return regionNames.of(code) ?? code; } catch { return code; }
}

/** `YYYYMMDD`, read in UTC. */
function icsDay(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

/** `YYYYMMDDTHHMMSS`, read in UTC. Floating: no zone, no trailing Z. */
function icsFloating(date) {
  return `${icsDay(date)}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/** `YYYYMMDDTHHMMSSZ` — a real instant, used for DTSTAMP. */
function icsInstant(date) {
  return `${icsFloating(date)}Z`;
}

/**
 * Escape the characters iCalendar gives its own meaning to.
 *
 * Backslashes go first, or the escapes added below get escaped again. An
 * unescaped comma is the damaging one: it splits a property into two values, so
 * a venue like "Rockefeller, Oslo" silently loses everything after the comma.
 */
function escapeText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Lowercase, hyphen-separated, safe in a filename. */
function slug(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** The concert's calendar day as `YYYY-MM-DD`, read in UTC like everything else. */
function dayOf(concertDate) {
  return typeof concertDate === 'string'
    ? concertDate.slice(0, 10)
    : new Date(concertDate).toISOString().slice(0, 10);
}

/**
 * Band names on the bill, from both sources, de-duplicated.
 *
 * Wishlist bands arrive as objects; everyone else is a plain name in the
 * concert's JSON `metadata`. Cleaning goes through lineupNames so the names here
 * match the ones stored at the write boundary.
 */
function lineupNames(concert) {
  const wishlist = (concert?.participating_bands ?? []).map((b) => b?.name).filter(Boolean);
  let extra = [];
  try {
    const parsed = JSON.parse(concert?.metadata || '[]');
    if (Array.isArray(parsed)) extra = cleanLineupNames(parsed);
  } catch {
    extra = [];
  }
  const seen = new Set(wishlist.map((n) => n.toLowerCase()));
  return [...wishlist, ...extra.filter((n) => !seen.has(n.toLowerCase()))];
}

/** `Tickets 450–800 NOK`, or null when the concert has no price. */
function priceLine(concert) {
  if (concert?.price_min == null) return null;
  const fmt = (n) => (Number.isInteger(n) ? n : n.toFixed(2));
  const currency = concert.price_currency || '';
  const range = concert.price_max != null && concert.price_max !== concert.price_min
    ? `${fmt(concert.price_min)}–${fmt(concert.price_max)}`
    : `from ${fmt(concert.price_min)}`;
  return `Tickets ${range} ${currency}`.trim();
}


// Sources whose stored concert_date is already a true UTC instant.
//
// The column does not mean the same thing for every row. Verified against the
// live pages on 2026-08-27: a Songkick concert reading "Doors open: 20:00" in
// Cologne is stored as 18:00Z, and one reading 18:00 in Utrecht as 17:00Z —
// both correct conversions. Bandsintown's 19:00 Stockholm show is stored as
// 19:00Z, which is the wall clock wearing a Z, and post_tours.py builds
// Ticketmaster values as `${localDate}T${localTime}Z` outright.
//
// Written floating, a Songkick time renders an hour or two early — 269 concerts
// were doing exactly that. Written as an instant, the calendar localises it.
//
// This is a stopgap. The real fix is to make the column mean one thing; see
// docs/superpowers/specs/2026-08-27-concert-time-normalisation-design.md in
// concert-map. Until then the rule lives here, named, rather than as an
// assumption spread across the file.
const UTC_INSTANT_SOURCES = new Set(['songkick']);

/**
 * Whether this source's stored time is a real instant rather than a wall clock.
 *
 * Anything unverified counts as a wall clock: that is the reading already
 * shipping, so it changes nothing rather than guessing in a new direction.
 *
 * @param {string|null|undefined} source
 * @returns {boolean}
 */
function storesRealInstant(source) {
  return UTC_INSTANT_SOURCES.has(source);
}

/**
 * The calendar-facing view of a concert. Null when there is no usable date —
 * there is no event to place.
 */
function concertEventFields(concert) {
  if (!concert?.concert_date) return null;
  const start = new Date(concert.concert_date);
  if (Number.isNaN(start.getTime())) return null;

  const bands = lineupNames(concert);
  const blurb = [
    bands.length ? `Playing: ${bands.join(', ')}` : null,
    priceLine(concert),
    concert.url || null,
  ].filter(Boolean);

  // Shows scraped without a start time land on exactly 00:00Z. Giving those an
  // invented evening slot would put a wrong time in the calendar for most of
  // the list, so they become all-day events instead.
  const allDay = start.getUTCHours() === 0 && start.getUTCMinutes() === 0 && start.getUTCSeconds() === 0;

  const end = new Date(start);
  if (allDay) end.setUTCDate(end.getUTCDate() + 1);
  else end.setUTCHours(end.getUTCHours() + EVENT_HOURS);

  const timed = storesRealInstant(concert.source) ? icsInstant : icsFloating;

  return {
    title: concert.name || concert.band || 'Concert',
    location: [concert.venue, concert.city, countryName(concert.country)].filter(Boolean).join(', '),
    description: blurb.join('\n'),
    allDay,
    // An all-day DTEND is exclusive: ending on the day of the show would render
    // it as a zero-length event, or drop it from the calendar altogether.
    //
    // A timed show is written as floating local time. The Z on concert_date is
    // not evidence the time really is UTC: Songkick's startDate usually carries
    // no zone, and the scraper stamps those naive local times with UTC, so
    // 19:00 at an Oslo venue is stored as 19:00Z. Treating that as an instant
    // puts the gig in the calendar at 21:00. Floating keeps the wall clock the
    // venue posted, which is the number on the ticket.
    start: allDay ? icsDay(start) : timed(start),
    end: allDay ? icsDay(end) : timed(end),
  };
}

/**
 * Fold a content line to the 75-octet limit, per RFC 5545.
 *
 * Continuation lines begin with a space, which counts towards their own limit.
 * The split walks code points rather than bytes so a multi-byte character —
 * every Nordic venue name has one — can't be cut in half into mojibake.
 */
function foldIcsLine(line) {
  if (encoder.encode(line).length <= MAX_OCTETS) return line;

  const out = [];
  let current = '';
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (octets + size > MAX_OCTETS) {
      out.push(current);
      current = ' ';
      octets = 1;
    }
    current += char;
    octets += size;
  }
  out.push(current);
  return out.join('\r\n');
}

/** The VEVENT lines for one concert, or null if it has no date. */
function vevent(concert, now) {
  const fields = concertEventFields(concert);
  if (!fields) return null;

  // A UID tied to the concert means re-importing, or a feed refresh, updates
  // the existing entry instead of leaving a second copy behind.
  const identity = concert.id ?? concert.event_id ?? `${fields.start}-${slug(fields.title)}`;

  return [
    'BEGIN:VEVENT',
    `UID:concert-${identity}@concert-map`,
    `DTSTAMP:${icsInstant(now)}`,
    fields.allDay ? `DTSTART;VALUE=DATE:${fields.start}` : `DTSTART:${fields.start}`,
    fields.allDay ? `DTEND;VALUE=DATE:${fields.end}` : `DTEND:${fields.end}`,
    `SUMMARY:${escapeText(fields.title)}`,
    fields.location ? `LOCATION:${escapeText(fields.location)}` : null,
    fields.description ? `DESCRIPTION:${escapeText(fields.description)}` : null,
    concert.url ? `URL:${escapeText(concert.url)}` : null,
    'END:VEVENT',
  ].filter(Boolean);
}

/** Wrap event lines in a VCALENDAR, folded, CRLF-terminated. */
function calendar(eventLines) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Concert Map//Concert Map//EN',
    'CALSCALE:GREGORIAN',
    ...eventLines,
    'END:VCALENDAR',
  ];
  // CRLF throughout, including after the final line: Outlook rejects a file
  // that uses bare newlines.
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

/**
 * A complete .ics file for one concert, or null if it has no date.
 *
 * @param {object} concert
 * @param {Date} [now] - Generation time for DTSTAMP; injectable for tests.
 * @returns {string|null}
 */
function concertToIcs(concert, now = new Date()) {
  const lines = vevent(concert, now);
  return lines ? calendar(lines) : null;
}

/**
 * One .ics file holding every concert given.
 *
 * Concerts with no date are skipped rather than failing the feed — one
 * unscheduled show must not cost a subscriber the rest of their calendar. An
 * empty list is still a valid calendar with no events.
 *
 * @param {object[]} concerts
 * @param {Date} [now]
 * @returns {string}
 */
function concertsToIcs(concerts, now = new Date()) {
  const events = (concerts ?? []).flatMap((c) => vevent(c, now) ?? []);
  return calendar(events);
}

/** A filename for a downloaded event, e.g. `2026-09-12-slipknot.ics`. */
function icsFilename(concert) {
  const parts = [
    concert?.concert_date ? dayOf(concert.concert_date) : null,
    slug(concert?.name || concert?.band || ''),
  ].filter(Boolean);
  return `${parts.join('-') || 'concert'}.ics`;
}

module.exports = {
  storesRealInstant,
  concertEventFields,
  foldIcsLine,
  concertToIcs,
  concertsToIcs,
  icsFilename,
};
