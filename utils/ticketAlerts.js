/**
 * Telling the people who follow a show what it is doing: the morning its
 * tickets go on sale, when they are on sale, when they sell out, if they come
 * back, and which acts have joined its bill.
 *
 * The bill is here rather than in the scrape digest (routes/data/wishlists/
 * notify.js) because that digest is about acts — it reaches you because an act
 * is on your wishlist or matches a watch, so a festival announcing twenty
 * acts you have never heard of would tell you nothing. Following a show is
 * about the show, and most of what joins a festival's bill has no Band row at
 * all: utils/concertBill.js reads those names out of metadata.
 *
 * Read off the show's own row rather than hooked into ingest. The row is what
 * the scraper keeps up to date, whichever path it came by, and comparing it
 * with what each follower was last told is an outbox for free: an alert that
 * failed to send leaves told_state and lineup_told where they were, and the
 * next run sends it.
 */
const axios = require("axios");
const prisma = require("../prisma/client");
// Through the module rather than destructured, so a test can stand in for
// Resend on this file's own copy of it.
const mail = require("./mail");
const { buildDiscordEmbeds } = require("./discordEmbeds");
const { isTimeZone, zonedInstant } = require("./weeklyRecap");
const { ticketState, saleDay, saleHasTime } = require("./ticketState");
const { billForConcert } = require("./concertBill");
const { canonicalBandName } = require("./lineupNames");
const { safeHref } = require("./html");

// Long enough to have the page open and be signed in when the sale opens.
const REMIND_BEFORE_MIN = 10;

// What time a sale opens when only its day is known, which today is every
// sale: Songkick names the day and nothing more. Ten in the morning, local,
// is where most of them land.
const ASSUMED_SALE_HOUR = 10;

/**
 * The instant a show's tickets go on sale, on the follower's clock.
 *
 * @param {{ticket_sale_start?: Date|string|null}} concert
 * @param {string} timeZone
 * @returns {{at: Date, assumed: boolean}|null} null when no sale date is known
 */
function saleInstant(concert, timeZone) {
  const day = saleDay(concert);
  if (!day) return null;
  // A source that gave a time: stored with one, so take it as it stands.
  if (saleHasTime(concert)) return { at: new Date(concert.ticket_sale_start), assumed: false };
  const [year, month, date] = day.split("-").map(Number);
  return { at: zonedInstant(Date.UTC(year, month - 1, date), timeZone, ASSUMED_SALE_HOUR), assumed: true };
}

const ALERTS = {
  // The bill's label names the acts, so it is built rather than looked up.
  lineup: "New on the bill",
  sold_out: "Sold out",
  back: "Tickets are back on sale",
  on_sale: "On sale now",
  sale_today: "On sale today",
};

// What a reminder says. A time we were given is worth naming; one we assumed
// is not, so that reads as the day alone.
function labelFor(kind, sale, timeZone) {
  if (kind !== "sale_today" || !sale || sale.assumed) return ALERTS[kind];
  const at = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(sale.at);
  return `On sale at ${at}`;
}

/**
 * What, if anything, to tell a follower about a show.
 *
 * Only the changes worth a ping are alerts. The rest — a show the sources stop
 * saying anything about, a sale date that appears — only move told_state on,
 * so a later change is measured from the right place.
 *
 * @param {{told_state: string, reminded_at: Date|null}} follow
 * @param {string} state - ticketState of the show now
 * @param {{sale: {at: Date}|null, now: Date}} clock
 * @returns {'sold_out'|'back'|'on_sale'|'sale_today'|null}
 */
function alertFor(follow, state, { sale, now }) {
  if (state !== follow.told_state) {
    if (state === "sold_out") return "sold_out";
    if (state === "on_sale") return follow.told_state === "sold_out" ? "back" : "on_sale";
    return null;
  }
  // Ten minutes before the sale opens. Late rather than never when the job
  // has been down: the alert still names the show, and going out once is
  // what reminded_at is for.
  if (state === "on_sale_soon" && !follow.reminded_at && sale && now.getTime() >= sale.at.getTime() - REMIND_BEFORE_MIN * 60 * 1000) {
    return "sale_today";
  }
  return null;
}

/**
 * The bill a follower was last told about, or null when none was recorded.
 *
 * Null is the first sight of a show — a follow made before this shipped, or
 * one whose first pass has not run — and says nothing. Otherwise every act on
 * the bill then would read as news the first time round.
 *
 * @param {string|null} told - ConcertFollow.lineup_told
 * @returns {string[]|null}
 */
function billTold(told) {
  if (typeof told !== "string") return null;
  try {
    const parsed = JSON.parse(told);
    return Array.isArray(parsed) ? parsed.filter((name) => typeof name === "string") : null;
  } catch {
    return null;
  }
}

// Everyone on the bill now, by name: the acts with a Band row and the plain
// strings in metadata alike.
const billNow = (concert) => billForConcert({
  bands: (concert.bands ?? []).map((ref) => ref.band_rel),
  metadata: concert.metadata,
}).map((act) => act.name);

/**
 * The acts on the bill now that this follower has not been told about.
 *
 * Compared on the canonical name rather than the literal string, for the
 * reason utils/concertBill.js matches that way: the scraper writes
 * "Architects (UK)" where the band row says "Architects", and a scrape that
 * changes which of the two it gives is not an act joining the bill.
 *
 * @param {string[]|null} told
 * @param {string[]} bill
 * @returns {string[]} empty when nothing is new, or nothing was recorded yet
 */
function billJoined(told, bill) {
  if (told === null) return [];
  const had = new Set(told.map(canonicalBandName).filter(Boolean));
  return bill.filter((name) => {
    const key = canonicalBandName(name);
    return key && !had.has(key);
  });
}

// Whether the bill to remember has moved at all — an act joining, and also one
// dropping off, which is not worth an alert but is worth recording, so its
// coming back later is.
function billMoved(told, bill) {
  if (told === null) return true;
  const had = new Set(told.map(canonicalBandName).filter(Boolean));
  const has = new Set(bill.map(canonicalBandName).filter(Boolean));
  return had.size !== has.size || [...has].some((key) => !had.has(key));
}

// How much of the line names acts before it starts counting them. A festival
// announcing thirty at once is one line in a Discord embed field and one in an
// email, so it is bounded — but generously, because the names are the news.
const BILL_LINE_MAX = 200;

// "New on the bill: Ghost, Opeth", or "…and 12 more" where they do not fit.
function billLabel(joined) {
  const named = [];
  let length = 0;
  for (const name of joined) {
    length += name.length + 2;
    if (named.length > 0 && length > BILL_LINE_MAX) break;
    named.push(name);
  }
  const rest = joined.length - named.length;
  return `${ALERTS.lineup}: ${named.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}

const showTitle = (concert) => concert.name
  || (concert.bands ?? []).map((b) => b.band_rel.name).join(", ")
  || concert.venue;

// What the listing a show was scraped from is called, for the link's words.
const SOURCE_NAMES = { songkick: "Songkick", bandsintown: "Bandsintown" };

/**
 * Where to go and buy, for an alert that is about tickets.
 *
 * Concert.url is the show's own listing — Songkick's event page or
 * Bandsintown's — which is as close to a box office as anything stored here
 * gets: it carries the vendor links, and on a sale day it is the page that
 * opens them. Named after its site, so the link says where it goes.
 *
 * @param {{url?: string|null, source?: string|null}} concert
 * @returns {{url: string, label: string}|null} null when the row has no usable link
 */
function ticketLink(concert) {
  const url = safeHref(concert.url);
  if (!url) return null;
  const site = SOURCE_NAMES[concert.source];
  return { url, label: site ? `Tickets on ${site}` : "Tickets" };
}

// The zone the weekly recap saved, or UTC as it falls back to.
function zoneOf(settings) {
  const zone = settings && typeof settings === "object" ? settings.timeZone : null;
  return isTimeZone(zone) ? zone : "UTC";
}

// See notify.js: only a bare snowflake is honoured as a ping.
function mentionFor(settings) {
  const id = settings && typeof settings === "object" ? settings.discord_user_id : null;
  return typeof id === "string" && /^\d+$/.test(id) ? `<@${id}>` : null;
}

async function postToDiscord(webhook, alerts, settings) {
  const embeds = buildDiscordEmbeds({
    title: alerts.length === 1 ? alerts[0].headline : "News about shows you follow",
    concerts: alerts.map(({ concert, label }) => ({ ...concert, note: label, tickets: ticketLink(concert) })),
  });
  const content = mentionFor(settings);
  for (const [i, embed] of embeds.entries()) {
    await axios.post(webhook, content && i === 0 ? { content, embeds: [embed] } : { embeds: [embed] }, { timeout: 10000 });
  }
}

/**
 * One pass over every follow of a show still to come.
 *
 * @param {{now?: Date}} [options]
 * @returns {Promise<{follows: number, alerted: number, failed: number}>}
 *   follows read, users told, users whose alerts could not be sent anywhere
 */
async function runTicketAlerts({ now = new Date() } = {}) {
  const startOfToday = new Date(now);
  startOfToday.setUTCHours(0, 0, 0, 0);

  const follows = await prisma.concertFollow.findMany({
    where: { concert_rel: { OR: [{ concert_date: null }, { concert_date: { gte: startOfToday } }] } },
    select: {
      user_id: true,
      concert_id: true,
      told_state: true,
      reminded_at: true,
      lineup_told: true,
      concert_rel: {
        select: {
          id: true, name: true, venue: true, city: true, country: true, concert_date: true, url: true,
          // The listing the alert links to, and the site to name it after.
          source: true,
          metadata: true, on_sale: true, sold_out: true, ticket_sale_start: true,
          bands: { select: { band_rel: { select: { name: true } } } },
        },
      },
      user_rel: { select: { email: true, settings: true, wishlists: { select: { discord_webhook: true } } } },
    },
  });

  const byUser = new Map();
  const quietMoves = [];
  for (const follow of follows) {
    const concert = follow.concert_rel;
    const state = ticketState(concert, now);
    const zone = zoneOf(follow.user_rel.settings);
    const sale = saleInstant(concert, zone);
    const kind = alertFor(follow, state, { sale, now });
    const bill = billNow(concert);
    const told = billTold(follow.lineup_told);
    const joined = billJoined(told, bill);

    // What has moved since this follower was last told. Only the fields that
    // actually changed: with nothing to say this is the whole write, and it
    // runs for every follow every few minutes.
    const moved = {
      ...(state !== follow.told_state && { told_state: state }),
      ...(billMoved(told, bill) && { lineup_told: JSON.stringify(bill) }),
    };

    // A show can have news of both kinds in one pass — a sell-out and an act
    // joining — and each is its own line in the message.
    const alerts = [];
    if (kind) {
      const label = labelFor(kind, sale, zone);
      alerts.push({ concert, label, headline: `${label}: ${showTitle(concert)}` });
    }
    if (joined.length > 0) {
      // The acts are named in the line itself, so the headline of a message
      // about nothing else names the show instead.
      alerts.push({ concert, label: billLabel(joined), headline: `${ALERTS.lineup}: ${showTitle(concert)}` });
    }

    if (alerts.length === 0) {
      // Nothing to say, but the bill or the ticket state may still have moved
      // on, and a later change is measured from where it is now.
      if (Object.keys(moved).length > 0) quietMoves.push({ follow, next: moved });
      continue;
    }
    // Written once this follower has been told, and not before, so nothing
    // that failed to send is forgotten.
    const next = { told_state: state, ...moved, ...(kind === "sale_today" && { reminded_at: now }) };
    if (!byUser.has(follow.user_id)) byUser.set(follow.user_id, { user: follow.user_rel, alerts: [], writes: [] });
    const entry = byUser.get(follow.user_id);
    entry.alerts.push(...alerts);
    entry.writes.push({ follow, next });
  }

  for (const { follow, next } of quietMoves) {
    await prisma.concertFollow.update({
      where: { user_id_concert_id: { user_id: follow.user_id, concert_id: follow.concert_id } },
      data: next,
    });
  }

  let alerted = 0;
  let failed = 0;
  for (const [userId, { user, alerts, writes }] of byUser) {
    // Every channel the user has, and told if any of them took it. Discord is
    // the one that buzzes a phone; the email is there for whoever has no
    // webhook, and as the record.
    let delivered = false;
    const webhook = user.wishlists?.discord_webhook;
    if (webhook) {
      try {
        await postToDiscord(webhook, alerts, user.settings);
        delivered = true;
      } catch (err) {
        console.error(`[ticketAlerts] Discord failed for ${userId}:`, err.response?.status ?? err.message);
      }
    }
    if (user.email) {
      try {
        await mail.sendTicketAlertEmail({
          to: user.email,
          items: alerts.map(({ concert, label, headline }) => ({
            title: showTitle(concert),
            alert: label,
            headline,
            venue: concert.venue,
            city: concert.city,
            country: concert.country,
            date: concert.concert_date,
            url: concert.url,
            // The link to go and buy by, spelled out: the title above is a
            // link too, but an alert that tickets are open wants one that
            // says so.
            tickets: ticketLink(concert),
          })),
        });
        delivered = true;
      } catch (err) {
        console.error(`[ticketAlerts] Email failed for ${userId}:`, err.message);
      }
    }
    // Nowhere took it: left as it was, so the next run tries again.
    if (!delivered) {
      failed++;
      continue;
    }
    alerted++;
    for (const { follow, next } of writes) {
      await prisma.concertFollow.update({
        where: { user_id_concert_id: { user_id: follow.user_id, concert_id: follow.concert_id } },
        data: next,
      });
    }
  }

  return { follows: follows.length, alerted, failed };
}

module.exports = { alertFor, saleInstant, billJoined, billLabel, ticketLink, runTicketAlerts, REMIND_BEFORE_MIN, ASSUMED_SALE_HOUR };
