/**
 * Telling the people who follow a show what its tickets are doing: the
 * morning they go on sale, when they are on sale, when they sell out, and if
 * they come back.
 *
 * Read off the show's own row rather than hooked into ingest. The row is what
 * the scraper keeps up to date, whichever path it came by, and comparing it
 * with what each follower was last told is an outbox for free: an alert that
 * failed to send leaves told_state where it was, and the next run sends it.
 */
const axios = require("axios");
const prisma = require("../prisma/client");
// Through the module rather than destructured, so a test can stand in for
// Resend on this file's own copy of it.
const mail = require("./mail");
const { buildDiscordEmbeds } = require("./discordEmbeds");
const { isTimeZone } = require("./weeklyRecap");
const { ticketState, saleDay } = require("./ticketState");

// Before the sales that open at nine or ten. Songkick gives a sale's day and
// not its hour, so the reminder goes in the morning of it.
const REMIND_AT_HOUR = 8;

const ALERTS = {
  sold_out: "Sold out",
  back: "Tickets are back on sale",
  on_sale: "On sale now",
  sale_today: "On sale today",
};

/**
 * What, if anything, to tell a follower about a show.
 *
 * Only the changes worth a ping are alerts. The rest — a show the sources stop
 * saying anything about, a sale date that appears — only move told_state on,
 * so a later change is measured from the right place.
 *
 * @param {{told_state: string, reminded_at: Date|null}} follow
 * @param {string} state - ticketState of the show now
 * @param {{saleDay: string|null, today: string, hour: number}} clock - the
 *   sale's day, and today and the hour on the follower's clock
 * @returns {'sold_out'|'back'|'on_sale'|'sale_today'|null}
 */
function alertFor(follow, state, { saleDay: day, today, hour }) {
  if (state !== follow.told_state) {
    if (state === "sold_out") return "sold_out";
    if (state === "on_sale") return follow.told_state === "sold_out" ? "back" : "on_sale";
    return null;
  }
  if (state === "on_sale_soon" && !follow.reminded_at && day === today && hour >= REMIND_AT_HOUR) return "sale_today";
  return null;
}

// The day ("YYYY-MM-DD") and the hour (0–23) on a wall clock in a zone.
const localDate = (now, timeZone) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const localHour = (now, timeZone) => Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));

const showTitle = (concert) => concert.name
  || (concert.bands ?? []).map((b) => b.band_rel.name).join(", ")
  || concert.venue;

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
    title: alerts.length === 1 ? `${ALERTS[alerts[0].kind]}: ${showTitle(alerts[0].concert)}` : "Tickets for shows you follow",
    concerts: alerts.map(({ concert, kind }) => ({ ...concert, note: ALERTS[kind] })),
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
      concert_rel: {
        select: {
          id: true, name: true, venue: true, city: true, country: true, concert_date: true, url: true,
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
    const kind = alertFor(follow, state, {
      saleDay: saleDay(concert),
      today: localDate(now, zone),
      hour: localHour(now, zone),
    });
    if (kind) {
      if (!byUser.has(follow.user_id)) byUser.set(follow.user_id, { user: follow.user_rel, alerts: [] });
      byUser.get(follow.user_id).alerts.push({ follow, concert, state, kind });
    } else if (state !== follow.told_state) {
      quietMoves.push({ follow, state });
    }
  }

  for (const { follow, state } of quietMoves) {
    await prisma.concertFollow.update({
      where: { user_id_concert_id: { user_id: follow.user_id, concert_id: follow.concert_id } },
      data: { told_state: state },
    });
  }

  let alerted = 0;
  let failed = 0;
  for (const [userId, { user, alerts }] of byUser) {
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
          items: alerts.map(({ concert, kind }) => ({
            title: showTitle(concert),
            alert: ALERTS[kind],
            venue: concert.venue,
            city: concert.city,
            country: concert.country,
            date: concert.concert_date,
            url: concert.url,
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
    for (const { follow, state, kind } of alerts) {
      await prisma.concertFollow.update({
        where: { user_id_concert_id: { user_id: follow.user_id, concert_id: follow.concert_id } },
        data: { told_state: state, ...(kind === "sale_today" && { reminded_at: now }) },
      });
    }
  }

  return { follows: follows.length, alerted, failed };
}

module.exports = { alertFor, runTicketAlerts, REMIND_AT_HOUR };
