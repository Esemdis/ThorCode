/**
 * The followed-show checker (THO-779): which shows' Songkick listings are due
 * a fresh read, what a follower is told about the last one, and what a read
 * may write back onto the show.
 *
 * ThorCode decides and python-crohn fetches, the way wander's flight status
 * works: every five minutes the sync service asks what is due
 * (routes/data/followChecks.js), reads those pages and posts what each said.
 * Written onto the Concert row rather than kept beside it, because the row is
 * what utils/ticketAlerts.js already reads every five minutes: a read that
 * moves the tickets on is an "On sale now" without any new alert code.
 *
 * Pure, so the cadence and the rules about what a read may overwrite are
 * pinned by tests rather than by waiting for a sale morning.
 */
const { ticketState, saleDay, saleHasTime, mergeTicketFields } = require("./ticketState");
const { mergedPrice } = require("./concertDedup");
const { safeHref } = require("./html");

const MIN = 60 * 1000;

// Every show with a listing is read at least this often. The copy in
// concert-map's Following tab says "every half hour", so this is a promise.
const STALE_MIN = 30;
// While a sale is about to open, or has just opened and nobody has seen it yet.
const HOT_MIN = 5;
// The window around a sale with a time: an hour before, so "not yet" is news,
// and two hours after, because vendors open late more often than early.
const HOT_BEFORE_MIN = 60;
const HOT_AFTER_MIN = 120;
// A sale known only by its day (every Songkick sale today) is read every five
// minutes from 06:00 to 12:00 UTC on that day: 07:00-13:00 in Central Europe,
// which covers the 09:00 and 10:00 openings nearly every European vendor uses,
// in summer and winter time alike. All day would be 288 reads per show.
const DAY_ONLY_HOT_UTC = [6, 12];
// "Check now" within this long of the last attempt asks for nothing: the row
// already says "Checked just now", and a double tap must not be two reads.
const RECHECK_GUARD_MIN = 2;
// Failed reads in a row before the row says it cannot read the listing. One is
// a page that timed out; two, half an hour apart at least, is worth saying.
const FAILING_AFTER = 2;
// The sync service ticks every five minutes, and stamps a read a few seconds
// after its tick starts. Measured exactly, a read due "every five minutes"
// would be a few seconds short at the next tick and wait for the one after, so
// every interval is compared a minute short.
const TICK_SLACK_MIN = 1;

const VENDOR_STATES = new Set(["on_sale", "sold_out", "on_sale_soon", "unknown"]);
// schema.org's eventStatus, as python-crohn reads it off the page's JSON-LD.
const EVENT_STATUSES = new Set(["scheduled", "cancelled", "postponed", "rescheduled", "moved_online"]);
const MAX_VENDORS = 20;
const MAX_VENDOR_NAME = 80;
const MAX_VENDOR_PRICE = 30;
const MAX_ERROR = 300;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function isSongkick(url) {
  const href = safeHref(url);
  if (!href) return null;
  const parsed = new URL(href);
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== "songkick.com" && !parsed.hostname.endsWith(".songkick.com")) return null;
  // The listing itself, not a query string someone appended to it.
  return `${parsed.origin}${parsed.pathname}`;
}

/**
 * The Songkick page a show's tickets are read from, or null when it has none.
 *
 * The stored url when it is one, else the page its Songkick event id names:
 * a show Bandsintown reached first keeps Bandsintown's url but still carries
 * the `sk_` id from when Songkick listed it too. A hashed id (`sk_` and hex,
 * from a listing with no number) names no page.
 *
 * @param {{url?: string|null, event_id?: string|null}} concert
 * @returns {string|null}
 */
function listingUrl(concert) {
  const own = concert?.url ? isSongkick(concert.url) : null;
  if (own) return own;
  const m = /^sk_(\d+)$/.exec(concert?.event_id ?? "");
  return m ? `https://www.songkick.com/concerts/${m[1]}` : null;
}

const startOfDay = (now) => {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/** Whether a show is still to come (today counts), or has no date to say. */
function upcoming(concert, now) {
  if (!concert?.concert_date) return true;
  return new Date(concert.concert_date).getTime() >= startOfDay(now).getTime();
}

/**
 * Whether a show's sale is close enough that it is read every five minutes.
 *
 * Only while the tickets are not on sale yet (or nobody knows): once a read
 * has seen them on sale, or sold out, the next half-hourly read is soon enough.
 *
 * @param {{on_sale?: boolean|null, sold_out?: boolean|null, ticket_sale_start?: Date|string|null}} concert
 * @param {Date} now
 */
function isHot(concert, now) {
  if (!concert?.ticket_sale_start) return false;
  const state = ticketState(concert, now);
  if (state !== "on_sale_soon" && state !== "unknown") return false;
  if (saleHasTime(concert)) {
    const at = new Date(concert.ticket_sale_start).getTime();
    return now.getTime() >= at - HOT_BEFORE_MIN * MIN && now.getTime() <= at + HOT_AFTER_MIN * MIN;
  }
  if (saleDay(concert) !== now.toISOString().slice(0, 10)) return false;
  const hour = now.getUTCHours();
  return hour >= DAY_ONLY_HOT_UTC[0] && hour < DAY_ONLY_HOT_UTC[1];
}

const at = (value) => (value ? new Date(value).getTime() : null);

/** Someone asked for a read, and none has been tried since. */
function isPending(check) {
  const requested = at(check?.requested_at);
  if (requested == null) return false;
  const attempted = at(check?.attempted_at);
  return attempted == null || requested > attempted;
}

/**
 * Whether a show is due a read now, and why.
 *
 * Measured from the last attempt rather than the last success, so a listing
 * that will not load is tried every half hour like the rest, not every tick.
 *
 * @param {object} concert - with url, event_id, concert_date and the ticket fields
 * @param {object|null} check - its ConcertListingCheck row
 * @param {Date} [now]
 * @returns {'requested'|'hot'|'never'|'stale'|null}
 */
function checkDue(concert, check, now = new Date()) {
  if (!listingUrl(concert) || !upcoming(concert, now)) return null;
  if (isPending(check)) return "requested";
  const attempted = at(check?.attempted_at);
  const age = attempted == null ? Infinity : now.getTime() - attempted;
  if (isHot(concert, now)) return age >= (HOT_MIN - TICK_SLACK_MIN) * MIN ? "hot" : null;
  if (attempted == null) return "never";
  return age >= (STALE_MIN - TICK_SLACK_MIN) * MIN ? "stale" : null;
}

const DUE_ORDER = { requested: 0, hot: 1, never: 2, stale: 3 };

/**
 * The shows to read this tick, most wanted first: someone waiting on it, a
 * sale about to open, never read, then the longest since a read was tried.
 *
 * While a full sync is running (`busy`) only the first two: that pass has a
 * browser of its own on Songkick, and a half-hourly refresh can wait for it.
 *
 * @param {Array<{concert: object, check: object|null}>} rows
 * @param {{now?: Date, limit?: number, busy?: boolean}} [options]
 * @returns {Array<{concert_id: number, url: string, reason: string}>}
 */
function dueChecks(rows, { now = new Date(), limit = 30, busy = false } = {}) {
  return rows
    .map(({ concert, check }) => ({ concert, check, reason: checkDue(concert, check, now) }))
    .filter(({ reason }) => reason && (!busy || reason === "requested" || reason === "hot"))
    .sort((a, b) => DUE_ORDER[a.reason] - DUE_ORDER[b.reason]
      || (at(a.check?.attempted_at) ?? 0) - (at(b.check?.attempted_at) ?? 0)
      || a.concert.id - b.concert.id)
    .slice(0, limit)
    .map(({ concert, reason }) => ({ concert_id: concert.id, url: listingUrl(concert), reason }));
}

/**
 * What a follower's row says about the checker: `null` for a show it has no
 * listing to read, so the row offers no "Check now" it cannot answer.
 *
 * @returns {{checked_at: Date|null, pending: boolean, hot: boolean, failing: boolean}|null}
 */
function checkView(concert, check, now = new Date()) {
  if (!listingUrl(concert)) return null;
  return {
    checked_at: check?.checked_at ?? null,
    pending: isPending(check),
    hot: upcoming(concert, now) && isHot(concert, now),
    failing: (check?.failures ?? 0) >= FAILING_AFTER,
  };
}

/**
 * Whether "Check now" should ask for a read of this show: it has a listing,
 * is still to come, and was not tried in the last couple of minutes. One
 * already waiting is counted, but not stamped again (see the route).
 */
function checkable(concert, check, now = new Date()) {
  if (!listingUrl(concert) || !upcoming(concert, now)) return false;
  if (isPending(check)) return true;
  const attempted = at(check?.attempted_at);
  return attempted == null || now.getTime() - attempted >= RECHECK_GUARD_MIN * MIN;
}

const text = (value, max) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

/**
 * The vendor rows as they are stored and shown, from whatever the sync
 * service posted. Every url goes through safeHref, because concert-map puts
 * these in an href: a `javascript:` link read off a page is a link nobody
 * should be able to click.
 *
 * @param {unknown} vendors
 * @returns {Array<{name: string|null, url: string|null, state: string, sale_date: string|null, price: string|null}>}
 */
function sanitizeVendors(vendors) {
  if (!Array.isArray(vendors)) return [];
  const out = [];
  for (const raw of vendors) {
    if (out.length >= MAX_VENDORS) break;
    if (!raw || typeof raw !== "object") continue;
    const name = text(raw.name, MAX_VENDOR_NAME);
    const url = typeof raw.url === "string" ? safeHref(raw.url.trim()) : null;
    if (!name && !url) continue;
    const price = typeof raw.price === "string" && raw.price.trim().length <= MAX_VENDOR_PRICE ? text(raw.price, MAX_VENDOR_PRICE) : null;
    out.push({
      name,
      url,
      state: VENDOR_STATES.has(raw.state) ? raw.state : "unknown",
      sale_date: typeof raw.sale_date === "string" && DAY.test(raw.sale_date) ? raw.sale_date : null,
      price,
    });
  }
  return out;
}

const finite = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

/**
 * The Concert fields one successful read writes, which may be none.
 *
 * The tickets go through mergeTicketFields, the rule every scrape merges by,
 * so a read of a page with nothing specific to say cannot clear a sale day
 * another read found; the price through the full sync's own price rule.
 * Vendors are replaced whenever the read listed them (the list is what the
 * page shows now), and the event status only when the page said one, so a
 * page that dropped its JSON-LD does not un-cancel a show.
 *
 * `tickets_opened_at` is stamped once, when a read sees on sale a show that
 * was waiting on a known sale day. Not on the first read of a show already on
 * sale when it was followed: "opened 10:02" would then be the time of the
 * read, not of the sale, and a guessed time that looks measured is worse than
 * none.
 *
 * @param {object} stored - the Concert row
 * @param {object} result - one `ok` result from POST /follows/checked
 * @param {Date} [now]
 * @returns {object}
 */
function checkedFields(stored, result, now = new Date()) {
  const incoming = {
    on_sale: typeof result.on_sale === "boolean" ? result.on_sale : null,
    sold_out: result.sold_out === true,
    ticket_sale_start: typeof result.ticket_sale_start === "string" && DAY.test(result.ticket_sale_start)
      ? result.ticket_sale_start
      : null,
    price_min: finite(result.price_min),
    price_max: finite(result.price_max),
    price_currency: text(result.price_currency, 8),
    source: "songkick",
  };
  // Without a minimum the other two say nothing, and a currency alone beside
  // another source's amount reads as a price in money nobody quoted.
  if (incoming.price_min == null) Object.assign(incoming, { price_max: null, price_currency: null });

  // Only what is new: a read every half hour of a price that has not moved
  // must not be a write every half hour.
  const price = Object.entries(mergedPrice(stored, incoming)).filter(([key, value]) => (stored[key] ?? null) !== value);
  const fields = {
    ...mergeTicketFields(stored, incoming, now),
    ...Object.fromEntries(price),
  };

  if (Array.isArray(result.vendors)) {
    const vendors = sanitizeVendors(result.vendors);
    // Postgres hands jsonb back with its keys reordered, so the stored list
    // is put through the same shape before comparing: compared as stored, it
    // differed every time and every half-hourly read rewrote the row.
    const was = Array.isArray(stored.vendors) ? JSON.stringify(sanitizeVendors(stored.vendors)) : null;
    if (JSON.stringify(vendors) !== was) fields.vendors = vendors;
  }
  if (EVENT_STATUSES.has(result.event_status) && result.event_status !== stored.event_status) {
    fields.event_status = result.event_status;
  }

  const before = ticketState(stored, now);
  const after = ticketState({ ...stored, ...fields }, now);
  if (!stored.tickets_opened_at && stored.ticket_sale_start && after === "on_sale"
    && (before === "on_sale_soon" || before === "unknown")) {
    fields.tickets_opened_at = now;
  }
  return fields;
}

/** An error from the sync service, short enough to keep. */
function errorText(error) {
  return text(typeof error === "string" ? error : "read failed", MAX_ERROR) ?? "read failed";
}

module.exports = {
  STALE_MIN,
  HOT_MIN,
  HOT_BEFORE_MIN,
  HOT_AFTER_MIN,
  DAY_ONLY_HOT_UTC,
  RECHECK_GUARD_MIN,
  FAILING_AFTER,
  listingUrl,
  upcoming,
  isHot,
  isPending,
  checkDue,
  dueChecks,
  checkView,
  checkable,
  sanitizeVendors,
  checkedFields,
  errorText,
};
