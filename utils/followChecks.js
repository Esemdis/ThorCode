/**
 * When a followed show's listing is due another read, and where to read it.
 *
 * The full sync reaches every show three times a day, which is fine for a
 * map and too slow for a show someone is waiting to buy tickets for: a sale
 * that opens at ten is "on sale now" by the afternoon pass. python-crohn's
 * followed-show checker (jobs/follows.py) ticks every five minutes and asks
 * GET /follows/check-pending which shows are due; this decides.
 *
 * - Every half hour, normally.
 * - Every five minutes from an hour before a known sale opens until it does,
 *   or until the sale day is over — the one stretch where minutes matter.
 * - Straight away when someone pressed "Check now".
 * - Backing off after a run of failures, so a listing that has gone away is
 *   not hammered every half hour for months — but never inside the sale
 *   window, where a failure is as likely the vendor's queue page as anything.
 *
 * Decided here rather than in the checker for the reason every other job in
 * python-crohn asks ThorCode what is owed: this is where the rows are, and
 * the checker keeps nothing between runs that a restart would lose.
 */
const { ticketState, saleDay } = require("./ticketState");
const { saleInstant } = require("./ticketAlerts");
const { isTimeZone, zonedInstant } = require("./weeklyRecap");
const { mergedFields } = require("./concertDedup");
const { movedFields } = require("./concertMove");
const { safeHref } = require("./html");

const MINUTE = 60 * 1000;

const NORMAL_EVERY_MIN = 30;
const HOT_EVERY_MIN = 5;
// How long before a sale opens the five-minute checks start.
const HOT_LEAD_MIN = 60;
// The checker ticks on the clock's fives, and a check finishes a few seconds
// after its tick. Without this, one that ran at 10:00:20 would not be due
// again until 10:30:20, miss the 10:30 tick and wait for 10:35.
const TICK_SLACK_MIN = 2;
// After this many failures in a row the gap doubles each time, up to six hours.
const BACKOFF_AFTER = 3;
const MAX_EVERY_MIN = 6 * 60;

// The clock a sale's assumed opening is read on. Songkick gives a day and no
// time, and ticketAlerts.js assumes ten in the morning; on a Berlin clock the
// hour before that also covers a nine o'clock opening in Stockholm and a
// nine o'clock one in London, which is ten in Berlin.
const CHECK_TIME_ZONE = isTimeZone(process.env.FOLLOW_CHECK_TZ) ? process.env.FOLLOW_CHECK_TZ : "Europe/Berlin";

/**
 * The stretch around a sale's opening when the show is checked every five
 * minutes, or null when `now` is not in it.
 *
 * Only while the show is still not on sale: the moment it flips, the stretch
 * is over. And only while it is still going ahead.
 *
 * @param {object} concert - ticket fields and event_status
 * @param {Date} now
 * @param {string} [timeZone]
 * @returns {{from: Date, until: Date}|null}
 */
function hotWindow(concert, now, timeZone = CHECK_TIME_ZONE) {
  if (concert.event_status === "cancelled") return null;
  if (ticketState(concert, now) !== "on_sale_soon") return null;
  const sale = saleInstant(concert, timeZone);
  if (!sale) return null;
  const from = new Date(sale.at.getTime() - HOT_LEAD_MIN * MINUTE);
  const [year, month, date] = saleDay(concert).split("-").map(Number);
  const until = zonedInstant(Date.UTC(year, month - 1, date + 1), timeZone);
  return now >= from && now < until ? { from, until } : null;
}

/**
 * How many minutes apart this show's checks are, as things stand.
 *
 * @param {object} concert
 * @param {Date} now
 * @param {string} [timeZone]
 */
function checkEvery(concert, now, timeZone = CHECK_TIME_ZONE) {
  if (hotWindow(concert, now, timeZone)) return HOT_EVERY_MIN;
  const failures = concert.ticket_check_failures ?? 0;
  if (failures >= BACKOFF_AFTER) {
    return Math.min(NORMAL_EVERY_MIN * 2 ** (failures - BACKOFF_AFTER + 1), MAX_EVERY_MIN);
  }
  return NORMAL_EVERY_MIN;
}

const instant = (value) => (value ? new Date(value) : null);

/**
 * Whether a followed show is due a check now.
 *
 * @param {object} concert - with ticket_check_attempted_at, ticket_check_requested_at,
 *   ticket_check_failures and the ticket fields
 * @param {Date} now
 * @param {string} [timeZone]
 * @returns {{due: boolean, hot: boolean, requested: boolean, next_at: Date}}
 *   next_at is when it falls due, which is now or earlier for a show due now
 */
function checkDue(concert, now, timeZone = CHECK_TIME_ZONE) {
  const hot = hotWindow(concert, now, timeZone) !== null;
  const attempted = instant(concert.ticket_check_attempted_at);
  const requested = instant(concert.ticket_check_requested_at);
  if (requested && (!attempted || requested > attempted)) return { due: true, hot, requested: true, next_at: requested };
  if (!attempted) return { due: true, hot, requested: false, next_at: now };
  const every = checkEvery(concert, now, timeZone);
  const next = new Date(attempted.getTime() + (every - TICK_SLACK_MIN) * MINUTE);
  return { due: now >= next, hot, requested: false, next_at: next };
}

const SONGKICK_HOSTS = new Set(["songkick.com", "www.songkick.com"]);
// A Songkick listing's own page, either shape it is stored in.
const SONGKICK_EVENT_PATH = /^\/(concerts\/\d+|festivals\/\d+\/id\/\d+)/;

/**
 * The page the checker reads for a show, or null when there is none it can.
 *
 * Songkick first, wherever the row has one: its event page lists every vendor
 * with what each is doing, where Bandsintown's marks every listing in stock.
 * The stored url is preferred over one built from the id because a festival's
 * listing lives under /festivals/; an id alone is enough for any other.
 *
 * @param {{url?: string|null, event_id?: string|null}} concert
 * @returns {{source: 'songkick'|'bandsintown', url: string}|null}
 */
function checkTarget(concert) {
  let stored = null;
  try {
    stored = concert.url ? new URL(concert.url) : null;
  } catch {
    stored = null;
  }
  if (stored && stored.protocol === "https:" && SONGKICK_HOSTS.has(stored.hostname) && SONGKICK_EVENT_PATH.test(stored.pathname)) {
    return { source: "songkick", url: `https://www.songkick.com${stored.pathname}` };
  }
  const id = typeof concert.event_id === "string" ? concert.event_id : "";
  const songkick = id.match(/^sk_(\d+)$/);
  if (songkick) return { source: "songkick", url: `https://www.songkick.com/concerts/${songkick[1]}` };
  const bandsintown = id.match(/^bit_(\d+)$/);
  if (bandsintown) return { source: "bandsintown", url: `https://www.bandsintown.com/e/${bandsintown[1]}` };
  return null;
}

const VENDOR_STATES = new Set(["on_sale", "on_sale_soon", "sold_out", "unknown"]);
const LISTING_HOSTS = new Set(["songkick.com", "bandsintown.com"]);

// A nameless row's name, from the site it links to — "ticketmaster.se" — but
// not a listing's own redirect, which would name Songkick as the vendor.
function vendorHost(url) {
  if (!url) return null;
  const host = new URL(url).hostname.replace(/^www\./, "");
  return LISTING_HOSTS.has(host) ? null : host;
}
// More than any listing has had, and a bound on what a page can make us store.
const MAX_VENDORS = 12;

/**
 * The vendor rows the checker read, kept to what an alert or the app shows.
 *
 * They come off a scraped page, so every field is checked here: a link that
 * is not http(s) is dropped, as safeHref drops one everywhere else.
 *
 * @param {unknown} vendors
 * @returns {{name: string, state: string, sale_date: string|null, url: string|null, price: string|null}[]|null}
 *   null when the check said nothing about vendors at all
 */
function cleanVendors(vendors) {
  if (!Array.isArray(vendors)) return null;
  const out = [];
  for (const vendor of vendors) {
    if (!vendor || typeof vendor !== "object") continue;
    const name = typeof vendor.name === "string" ? vendor.name.trim().slice(0, 80) : "";
    const url = vendor.url ? safeHref(vendor.url) : null;
    if (!name && !url) continue;
    out.push({
      name: name || vendorHost(url) || "Tickets",
      state: VENDOR_STATES.has(vendor.state) ? vendor.state : "unknown",
      sale_date: typeof vendor.sale_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(vendor.sale_date) ? vendor.sale_date : null,
      url,
      price: typeof vendor.price === "string" && vendor.price.trim() ? vendor.price.trim().slice(0, 24) : null,
    });
    if (out.length === MAX_VENDORS) break;
  }
  return out;
}

// What a listing's schema.org eventStatus says, as event_status stores it.
// Rescheduled is a show going ahead on another day: the day is the news, and
// the move it reads as says so.
const EVENT_STATUSES = { cancelled: "cancelled", postponed: "postponed", scheduled: null, rescheduled: null };

/**
 * What one check of a listing changes about the stored show.
 *
 * The concert-shaped part goes through the same merge /bulk uses, so the
 * checker is held to every rule the full sync is — a listing marked in stock
 * by default cannot clear a sale day, a sold-out show comes back only when a
 * source says it is selling, a bill only grows — and through the same move
 * rules, since it reads the show's own listing by its id. Never its url: the
 * page read is the listing, not a better link to it.
 *
 * @param {object} stored - the row as it is
 * @param {object} check - one entry of POST /follows/checks
 * @param {Date} [now]
 * @returns {object} fields for concert.update — only what is new
 */
function checkUpdate(stored, check, now = new Date()) {
  const { url: _url, ...incoming } = check.concert && typeof check.concert === "object" ? check.concert : {};
  const data = { ...mergedFields(stored, incoming, now), ...movedFields(stored, incoming, now) };

  const vendors = cleanVendors(check.vendors);
  if (vendors && JSON.stringify(vendors) !== JSON.stringify(stored.ticket_vendors ?? null)) data.ticket_vendors = vendors;

  if (Object.prototype.hasOwnProperty.call(EVENT_STATUSES, check.event_status)) {
    const status = EVENT_STATUSES[check.event_status];
    if ((stored.event_status ?? null) !== status) data.event_status = status;
  }

  // The sale's real opening, to within a check — but only where the show was
  // known not to be selling. From "no news yet" it may have been on sale for
  // months, and this would be the day we happened to look.
  const before = ticketState(stored, now);
  if ((before === "on_sale_soon" || before === "sold_out") && ticketState({ ...stored, ...data }, now) === "on_sale") {
    data.tickets_opened_at = now;
  }
  return data;
}

module.exports = {
  cleanVendors,
  checkUpdate,
  hotWindow,
  checkEvery,
  checkDue,
  checkTarget,
  CHECK_TIME_ZONE,
  NORMAL_EVERY_MIN,
  HOT_EVERY_MIN,
  HOT_LEAD_MIN,
};
