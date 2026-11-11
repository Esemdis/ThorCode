/**
 * The sync service's side of the followed-show checker (THO-779).
 *
 * python-crohn asks every five minutes which followed shows' Songkick listings
 * are due a read, reads them, and posts what each page said. Which shows, how
 * often and what a read may overwrite are decided here (utils/followCheck.js);
 * the sync service only fetches and posts, as it does for wander's flights.
 *
 * Mounted on /data/concerts beside the notification routes, for the SYSTEM
 * token the sync service already signs in with.
 */
const express = require("express");
const router = express.Router();
const { query, body, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");
const { dueChecks, checkedFields, errorText } = require("../../utils/followCheck");

// One POST is at most one tick's worth and then some: the sync service reads
// FOLLOW_CHECK_MAX_PER_TICK (30) a tick.
const MAX_RESULTS = 100;

const CHECKED_CONCERT = {
  id: true, url: true, event_id: true, source: true,
  on_sale: true, sold_out: true, ticket_sale_start: true,
  price_min: true, price_max: true, price_currency: true,
  vendors: true, event_status: true, tickets_opened_at: true,
};

// GET /follows/check-due?limit=30&busy=1 — the listings to read this tick,
// most wanted first. `busy` while the sync service's full sync is running, so
// only the reads someone is waiting on and the sales about to open are listed.
router.get(
  "/follows/check-due",
  [
    auth,
    roleCheck(["ADMIN", "SYSTEM"]),
    query("limit").optional().isInt({ min: 1, max: MAX_RESULTS }).withMessage(`limit must be 1-${MAX_RESULTS}`),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 30;
    const busy = req.query.busy === "1" || req.query.busy === "true";

    try {
      const now = new Date();
      const startOfToday = new Date(now);
      startOfToday.setUTCHours(0, 0, 0, 0);
      // One row per show, however many follow it: the listing is the show's.
      const concerts = await prisma.concert.findMany({
        where: {
          follows: { some: {} },
          OR: [{ concert_date: null }, { concert_date: { gte: startOfToday } }],
        },
        select: {
          id: true, url: true, event_id: true, concert_date: true,
          on_sale: true, sold_out: true, ticket_sale_start: true,
          listing_check: { select: { attempted_at: true, requested_at: true } },
        },
      });
      const due = dueChecks(
        concerts.map((concert) => ({ concert, check: concert.listing_check })),
        { now, limit, busy },
      );
      res.json(due);
    } catch (error) {
      console.error("Error listing followed shows due a check:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /follows/checked — what the reads said, `{ results: [...] }`. Each is
// `{ concert_id, ok: true, on_sale, sold_out, ticket_sale_start, price_min,
// price_max, price_currency, vendors, event_status }` or `{ concert_id,
// ok: false, error, blocked? }`. One transaction per show, so one row that
// will not write does not lose the rest of the tick.
router.post(
  "/follows/checked",
  [
    auth,
    roleCheck(["ADMIN", "SYSTEM"]),
    body("results").isArray({ max: MAX_RESULTS }).withMessage(`results must be a list of at most ${MAX_RESULTS}`),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    let updated = 0;
    let failed = 0;
    let unknown = 0;
    let errored = 0;
    for (const result of req.body.results) {
      const concertId = Number(result?.concert_id);
      if (!Number.isInteger(concertId) || concertId < 1) {
        unknown += 1;
        continue;
      }
      try {
        // Applied whether anyone still follows the show or not: unfollowed
        // between the list and the post, the read is still the listing's news.
        const outcome = await prisma.$transaction(async (tx) => {
          const stored = await tx.concert.findUnique({ where: { id: concertId }, select: CHECKED_CONCERT });
          if (!stored) return "unknown";
          const now = new Date();
          if (result.ok === true) {
            const fields = checkedFields(stored, result, now);
            if (Object.keys(fields).length > 0) await tx.concert.update({ where: { id: concertId }, data: fields });
            await tx.concertListingCheck.upsert({
              where: { concert_id: concertId },
              create: { concert_id: concertId, checked_at: now, attempted_at: now, failures: 0 },
              update: { checked_at: now, attempted_at: now, failures: 0, last_error: null },
            });
            return "updated";
          }
          // A failed read still moves attempted_at, so a listing that will not
          // load waits its half hour like the rest instead of every tick, and
          // a "Check now" on it stops showing as on its way.
          const lastError = (result.blocked ? "blocked: " : "") + errorText(result.error);
          await tx.concertListingCheck.upsert({
            where: { concert_id: concertId },
            create: { concert_id: concertId, attempted_at: now, failures: 1, last_error: lastError },
            update: { attempted_at: now, failures: { increment: 1 }, last_error: lastError },
          });
          return "failed";
        });
        if (outcome === "updated") updated += 1;
        else if (outcome === "failed") failed += 1;
        else unknown += 1;
      } catch (error) {
        // Logged, counted and skipped: the show stays due and is read again.
        console.error(`Error storing the check of concert ${concertId}:`, error);
        errored += 1;
      }
    }
    res.json({ updated, failed, unknown, errors: errored });
  }
);

module.exports = router;
