/**
 * A week of new concerts: how many shows by your bands were added in one
 * calendar week, and in which cities.
 *
 * Three readers: the Updates panel's Weekly tab, its "Send to Discord" button,
 * and the Monday cron for anyone who asked for the post. All of them go
 * through weeklyRecap, so the tab and the post can never disagree about which
 * shows a week holds.
 *
 * A week runs Monday to Monday on the viewer's own clock. The server's clock
 * is UTC, and a Swedish week starting there would file a show added at 00:30
 * on a Monday morning under the week before.
 */
// Through the module rather than destructured, so a test can stand in for
// Discord on this file's own copy of it.
const axios = require("axios");
const prisma = require("../prisma/client");
const { buildRecapEmbed } = require("./discordEmbeds");

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether Intl knows the zone, which is all weekBounds asks of one. */
function isTimeZone(value) {
  if (typeof value !== "string" || value === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// What a zone's clocks read at an instant, as numbers. h23, because some
// versions of ICU read midnight as hour 24 of the day before.
function wallClock(instant, timeZone) {
  const parts = {};
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
  });
  for (const { type, value } of format.formatToParts(instant)) parts[type] = Number(value);
  return parts;
}

// How far ahead of UTC the zone's clocks are at an instant.
function offsetAt(instant, timeZone) {
  const w = wallClock(instant, timeZone);
  const read = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return read - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant a zone's clocks read a time of day on a calendar day.
 *
 * Asked twice: when the clocks change between the first guess and the answer,
 * the offset at the guess is the wrong one.
 *
 * @param {number} dayMs - UTC midnight of the calendar day
 * @param {string} timeZone
 * @param {number} [hour] - on the zone's clocks
 * @param {number} [minute]
 * @returns {Date}
 */
function zonedInstant(dayMs, timeZone, hour = 0, minute = 0) {
  const target = dayMs + (hour * 60 + minute) * 60 * 1000;
  const guess = target - offsetAt(new Date(target), timeZone);
  return new Date(target - offsetAt(new Date(guess), timeZone));
}

// The instant a zone's clocks strike midnight on a calendar day, given as UTC
// midnight of that day.
const midnightIn = (dayMs, timeZone) => zonedInstant(dayMs, timeZone);

// ISO 8601: a week is numbered in the year its Thursday falls in.
function isoWeek(mondayMs) {
  const thursday = new Date(mondayMs + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  return { year, week: Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1 };
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The calendar week holding `now` on a zone's clocks, or one before it.
 *
 * `first_day` and `last_day` are the Monday and Sunday as plain dates, for
 * labels. `start` and `end` are the instants the week runs between; `end` is
 * the next Monday's midnight, and is not part of it.
 *
 * @param {Date} now
 * @param {string} timeZone - an IANA zone, e.g. "Europe/Stockholm"
 * @param {number} [weeksAgo] - 0 for the week holding now, 1 for the last one
 */
function weekBounds(now, timeZone, weeksAgo = 0) {
  const today = wallClock(now, timeZone);
  const day = Date.UTC(today.year, today.month - 1, today.day);
  const sinceMonday = (new Date(day).getUTCDay() + 6) % 7;
  const monday = day - (sinceMonday + 7 * weeksAgo) * DAY_MS;
  return {
    start: midnightIn(monday, timeZone),
    end: midnightIn(monday + 7 * DAY_MS, timeZone),
    first_day: isoDay(monday),
    last_day: isoDay(monday + 6 * DAY_MS),
    ...isoWeek(monday),
  };
}

// Still to come when it was added. A show imported from someone's history is
// created today with a date years back, and it was never news. Compared by
// calendar day in UTC, the day concert_date is filed under, so a show added on
// the day it is played still counts.
function addedAhead(concert) {
  if (!concert.concert_date) return true;
  const addedOn = new Date(concert.created_at);
  addedOn.setUTCHours(0, 0, 0, 0);
  return new Date(concert.concert_date) >= addedOn;
}

// Biggest first, then alphabetical, so a tie reads the same every time.
const byCount = (key) => (a, b) => b.count - a.count || String(a[key] ?? "").localeCompare(String(b[key] ?? ""));

// Soonest first, and a show not dated yet after every one that is.
const bySoonest = (a, b) => {
  const at = (c) => (c.concert_date ? new Date(c.concert_date).getTime() : Infinity);
  return at(a) - at(b) || a.id - b.id;
};

/**
 * Count concerts by city, listing each city's shows soonest first.
 *
 * A city is a name in a country, as a City row is: London in England and
 * London in Ontario are two places. A show counts once however many of your
 * bands are on it: a festival with three of them is one new concert in its
 * town, and one for each band.
 *
 * @param {Array<{id: number, city: string, country: string, concert_date: Date|null,
 *   name: string|null, venue: string, festival: boolean, url: string|null,
 *   participating_bands: Array}>} concerts
 * @returns {{total: number, country_count: number, cities: Array, bands: Array}} biggest first
 */
function summarizeWeek(concerts) {
  const cities = new Map();
  const bands = new Map();

  for (const concert of concerts) {
    // A blank name is one place, Unknown, rather than one per spelling.
    const city = concert.city || null;
    const country = concert.country || null;
    const key = `${country ?? ""}|${city ?? ""}`;
    let entry = cities.get(key);
    if (!entry) {
      entry = { city, country, count: 0, concerts: [] };
      cities.set(key, entry);
    }
    entry.count += 1;
    entry.concerts.push({
      id: concert.id,
      concert_date: concert.concert_date ?? null,
      name: concert.name ?? null,
      venue: concert.venue ?? null,
      festival: concert.festival === true,
      url: concert.url ?? null,
      bands: [...concert.participating_bands].sort((a, b) => a.name.localeCompare(b.name)),
    });
    for (const band of concert.participating_bands) {
      const tally = bands.get(band.id) ?? { ...band, count: 0 };
      tally.count += 1;
      bands.set(band.id, tally);
    }
  }

  return {
    total: concerts.length,
    country_count: new Set([...cities.values()].map((c) => c.country).filter(Boolean)).size,
    cities: [...cities.values()]
      .map((c) => ({ ...c, concerts: c.concerts.sort(bySoonest) }))
      .sort(byCount("city")),
    bands: [...bands.values()].sort(byCount("name")),
  };
}

/**
 * The recap of one week for a wishlist.
 *
 * @param {Array<{band_id: number, tier: string}>} bandRefs - the wishlist's bands
 * @param {{now?: Date, timeZone: string, weeksAgo?: number}} options
 */
async function weeklyRecap(bandRefs, { now = new Date(), timeZone, weeksAgo = 0 }) {
  const bounds = weekBounds(now, timeZone, weeksAgo);
  const tiers = new Map(bandRefs.map((b) => [b.band_id, b.tier]));
  const bandIds = [...tiers.keys()];

  const rows = bandIds.length === 0 ? [] : await prisma.concert.findMany({
    where: {
      created_at: { gte: bounds.start, lt: bounds.end },
      bands: { some: { band: { in: bandIds } } },
      // An attended show brought in from setlist.fm is a record of a night,
      // not an announcement. Null is said outright: SQL's != never matches it.
      OR: [{ source: null }, { source: { not: "setlistfm" } }],
    },
    select: {
      id: true,
      name: true,
      venue: true,
      festival: true,
      url: true,
      city: true,
      country: true,
      concert_date: true,
      created_at: true,
      bands: {
        where: { band: { in: bandIds } },
        select: { band_rel: { select: { id: true, name: true } } },
      },
    },
  });

  const concerts = rows.filter(addedAhead).map((c) => ({
    id: c.id,
    name: c.name,
    venue: c.venue,
    festival: c.festival === true,
    url: c.url,
    city: c.city,
    country: c.country,
    concert_date: c.concert_date,
    participating_bands: c.bands.map((b) => ({
      id: b.band_rel.id, name: b.band_rel.name, tier: tiers.get(b.band_rel.id),
    })),
  }));

  return { ...bounds, time_zone: timeZone, ...summarizeWeek(concerts) };
}

/** Posts a recap to a Discord webhook. Throws what axios throws. */
async function postRecap(webhook, recap) {
  await axios.post(webhook, { embeds: [buildRecapEmbed(recap)] }, { timeout: 10000 });
}

/**
 * The Monday post: last week's recap, to every wishlist whose owner turned it
 * on and has somewhere for it to go.
 *
 * Last week is the latest one that has ended on the owner's clock. A week with
 * nothing in it is not posted. One missed — the server down on a Monday
 * morning — is not caught up the week after: it is a recap, and the tab still
 * has it.
 *
 * @returns {Promise<{sent: number, failed: number, quiet: number}>}
 */
async function sendWeeklyRecaps(now = new Date()) {
  const wishlists = await prisma.wishlist.findMany({
    where: { discord_webhook: { not: null } },
    select: {
      id: true,
      discord_webhook: true,
      user_rel: { select: { settings: true } },
      bands: { select: { band_id: true, tier: true } },
    },
  });

  const result = { sent: 0, failed: 0, quiet: 0 };
  for (const wishlist of wishlists) {
    const settings = wishlist.user_rel?.settings;
    if (!settings || typeof settings !== "object" || settings.weeklyRecap !== true) continue;
    const timeZone = isTimeZone(settings.timeZone) ? settings.timeZone : "UTC";

    const recap = await weeklyRecap(wishlist.bands, { now, timeZone, weeksAgo: 1 });
    if (recap.total === 0) {
      result.quiet += 1;
      continue;
    }
    try {
      await postRecap(wishlist.discord_webhook, recap);
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
      console.error(`[weeklyRecap] Failed to post to wishlist ${wishlist.id}:`, err.response?.status ?? err.message);
    }
  }
  return result;
}

module.exports = { isTimeZone, zonedInstant, weekBounds, summarizeWeek, weeklyRecap, postRecap, sendWeeklyRecaps };
