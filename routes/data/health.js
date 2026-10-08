/**
 * What the nightly jobs still have left to do, as counts.
 *
 * The four sync buttons in the app fire a job and report "done" — they cannot
 * say what the job was for, because the endpoints that know are the cron
 * feeds: they are SYSTEM-only and they return whole rows, thousands of them,
 * so a browser can neither call them nor afford to.
 *
 * So this is a separate read: the same queries as the feeds, run as `count`,
 * shaped to mirror the buttons one for one. It reads nothing a user could not
 * already infer by opening every band and looking, and it writes nothing at
 * all, which is why ADMIN is enough where the feeds need SYSTEM.
 */

const express = require("express");
const router = express.Router();
const { Prisma } = require("@prisma/client");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");
const { rateLimiter } = require("../../utils/rateLimiter");
const { archiveStatus } = require("../../utils/mediaHealth");

const rateLimit = rateLimiter({
  message: "Too many requests to the health route, please try again later.",
});

const DAY_MS = 24 * 60 * 60 * 1000;

// The forecast horizon Open-Meteo answers for. Past it there is nothing to
// fetch, so a show in October is not "missing" its weather in September.
const FORECAST_DAYS = 16;

// The staleness rule in GET /bands/setlist-pending, which is what the Setlists
// button ends up asking for. Duplicated rather than imported because that
// route hands the value to Prisma inline; if one moves, this comment is the
// thread back to the other.
const SETLIST_STALE_DAYS = 3;

// A followed show the checker has not read in this long is one it is behind
// on: its cadence is half an hour, so two hours is four reads missed.
const FOLLOW_STALE_MS = 2 * 60 * 60 * 1000;
// The run of failures utils/followChecks.js starts backing off at.
const FOLLOW_FAILING = 3;

/**
 * GET /data/concerts/health — how much work each nightly job has waiting.
 *
 * Counts only. An admin looking at this wants to know whether pressing a
 * button will do anything, not which rows it will touch.
 */
router.get(
  "/health",
  [auth, roleCheck(["ADMIN", "SYSTEM"]), rateLimit],
  async (_req, res) => {
    try {
      const now = new Date();
      const forecastEnd = new Date(now.getTime() + FORECAST_DAYS * DAY_MS);
      const setlistStale = new Date(now.getTime() - SETLIST_STALE_DAYS * DAY_MS);
      const aDayAgo = new Date(now.getTime() - DAY_MS);
      const followStale = new Date(now.getTime() - FOLLOW_STALE_MS);
      const startOfToday = new Date(now);
      startOfToday.setUTCHours(0, 0, 0, 0);
      // The checker's queue as GET /follows/check-pending reads it, less the
      // cadence: every followed show still to come.
      const followed = {
        follows: { some: {} },
        OR: [{ concert_date: null }, { concert_date: { gte: startOfToday } }],
      };

      // The backfill's queue, spelled exactly as utils/setlistBackfill.js
      // spells it: a past show someone attended, still missing a setlist for a
      // band that has an MBID to look one up by. A band without an MBID can
      // never be matched, so counting it here would report work that no run
      // will ever get through.
      const backfillQueue = {
        concert_date: { lt: now },
        attendances: { some: {} },
        bands: { some: { setlist: { equals: Prisma.DbNull }, band_rel: { MBID: { not: null } } } },
      };

      const [
        bandsTotal, bandsNoSetlist, bandsStaleSetlist, bandsNoSpotifyId, bandsPhotoStale,
        upcoming, upcomingNoCoords, weatherMissing, weatherRefreshable,
        setlistQueue, setlistNeverChecked, setlistCheckedToday,
        followedShows, followNeverChecked, followStaleCount, followFailing, followLatest, followFailure,
      ] = await prisma.$transaction([
        prisma.band.count(),
        prisma.band.count({ where: { setlist: { equals: Prisma.DbNull } } }),
        prisma.band.count({
          where: { setlist: { not: Prisma.DbNull }, setlist_updated_at: { lt: setlistStale } },
        }),
        // A band with no Spotify id can never resolve a photo, so this is the
        // number the photo sync has to fix first rather than a number it will
        // work through.
        prisma.band.count({ where: { spotify_id: null } }),
        prisma.band.count({
          where: { OR: [{ spotify_checked_at: null }, { spotify_checked_at: { lt: aDayAgo } }] },
        }),

        prisma.concert.count({ where: { concert_date: { gte: now } } }),
        // No coordinates means no pin and no weather — invisible on the map
        // rather than merely incomplete, which is why it is worth its own row.
        prisma.concert.count({
          where: {
            concert_date: { gte: now },
            OR: [{ latitude: null }, { longitude: null }],
          },
        }),
        prisma.concert.count({
          where: {
            concert_date: { gte: now, lte: forecastEnd },
            latitude: { not: null }, longitude: { not: null },
            weather: { equals: Prisma.DbNull },
          },
        }),
        // Inside the forecast window with weather already stored. The job
        // refetches these every run because a forecast moves, so they are work
        // the button will do — just not a gap it will close.
        prisma.concert.count({
          where: {
            concert_date: { gte: now, lte: forecastEnd },
            latitude: { not: null }, longitude: { not: null },
            weather: { not: Prisma.DbNull },
          },
        }),

        prisma.concert.count({ where: backfillQueue }),
        prisma.concert.count({ where: { ...backfillQueue, setlist_checked_at: null } }),
        prisma.concert.count({
          where: { ...backfillQueue, setlist_checked_at: { gte: aDayAgo } },
        }),

        // The followed-show checker, which has no button but the per-show
        // "Check now": whether it is keeping up, and what it cannot read.
        prisma.concert.count({ where: followed }),
        prisma.concert.count({ where: { ...followed, tickets_checked_at: null } }),
        prisma.concert.count({ where: { ...followed, tickets_checked_at: { lt: followStale } } }),
        prisma.concert.count({ where: { ...followed, ticket_check_failures: { gte: FOLLOW_FAILING } } }),
        prisma.concert.aggregate({ where: followed, _max: { tickets_checked_at: true } }),
        // The latest failure, so the line can say why rather than only how many.
        prisma.concert.findFirst({
          where: { ...followed, ticket_check_failures: { gte: FOLLOW_FAILING } },
          orderBy: { ticket_check_attempted_at: "desc" },
          select: { name: true, venue: true, ticket_check_error: true },
        }),
      ]);

      // Not a queue like everything else here, and deliberately included
      // anyway: a share that dropped produces no symptom of its own. The
      // listings keep working because they never touch disk, and the only
      // evidence is a gallery of images that will not load. This is the one
      // place an admin already looks.
      const archive = await archiveStatus();

      res.json({
        checked_at: now.toISOString(),
        bands: {
          total: bandsTotal,
          no_setlist: bandsNoSetlist,
          stale_setlist: bandsStaleSetlist,
          no_spotify_id: bandsNoSpotifyId,
          photo_stale: bandsPhotoStale,
        },
        concerts: {
          upcoming,
          no_coordinates: upcomingNoCoords,
        },
        weather: {
          missing: weatherMissing,
          refreshable: weatherRefreshable,
          forecast_days: FORECAST_DAYS,
        },
        // The backfill, not the band-level setlist sweep above: this is the
        // queue of shows you attended whose setlist is still unknown.
        setlists: {
          queue: setlistQueue,
          never_checked: setlistNeverChecked,
          checked_today: setlistCheckedToday,
        },
        follow_checks: {
          followed: followedShows,
          never_checked: followNeverChecked,
          stale: followStaleCount,
          failing: followFailing,
          last_checked_at: followLatest?._max?.tickets_checked_at ?? null,
          last_error: followFailure
            ? { show: followFailure.name || followFailure.venue, error: followFailure.ticket_check_error }
            : null,
        },
        archive,
      });
    } catch (error) {
      console.error("Error building health counts:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
