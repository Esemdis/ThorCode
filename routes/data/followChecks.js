/**
 * The followed-show checker's side of ThorCode.
 *
 * python-crohn's jobs/follows.py ticks every five minutes. Each tick asks
 * GET /follows/check-pending which followed shows are due a read — the
 * cadence is utils/followChecks.js — reads those listings and only those, and
 * posts what it found to POST /follows/checks, which writes it and tells the
 * followers straight away rather than on the alert cron's next turn.
 *
 * SYSTEM, as every feed the sync service reads or writes is. ADMIN too, so
 * either can be driven by hand.
 */
const express = require("express");
const router = express.Router();
const { body, query, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");
const { checkDue, checkTarget, checkUpdate } = require("../../utils/followChecks");
const { runTicketAlertsSerially } = require("../../utils/ticketAlerts");

// A pass that took more than this would run into the next tick. The checker
// reads two pages at a time, a few seconds each, so forty is about a minute.
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;
const ERROR_MAX = 300;

const startOfDay = (now) => {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day;
};

// Every followed show still to come, the way the alert pass reads them.
const followedUpcoming = (now) => ({
  follows: { some: {} },
  OR: [{ concert_date: null }, { concert_date: { gte: startOfDay(now) } }],
});

// GET /follows/check-pending — the followed shows due a read, most urgent first
router.get(
  "/follows/check-pending",
  [auth, roleCheck(["ADMIN", "SYSTEM"]), query("limit").optional().isInt({ min: 1, max: MAX_LIMIT })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : DEFAULT_LIMIT;

    try {
      const now = new Date();
      const concerts = await prisma.concert.findMany({
        where: followedUpcoming(now),
        select: {
          id: true, name: true, url: true, event_id: true, event_status: true,
          on_sale: true, sold_out: true, ticket_sale_start: true,
          ticket_check_attempted_at: true, ticket_check_requested_at: true, ticket_check_failures: true,
        },
      });

      const due = [];
      for (const concert of concerts) {
        const target = checkTarget(concert);
        if (!target) continue;
        const { due: isDue, hot, requested } = checkDue(concert, now);
        if (!isDue) continue;
        due.push({
          concert_id: concert.id, name: concert.name, ...target, hot, requested,
          attempted: concert.ticket_check_attempted_at ? new Date(concert.ticket_check_attempted_at).getTime() : 0,
        });
      }
      // Someone waiting on a button first, then a sale about to open, then
      // whatever has gone longest unread — so a pass cut short by the limit
      // drops the shows that can best afford to wait.
      due.sort((a, b) => (b.requested - a.requested) || (b.hot - a.hot) || (a.attempted - b.attempted));
      res.json(due.slice(0, limit).map(({ attempted, ...entry }) => entry));
    } catch (error) {
      console.error("Error listing followed shows due a check:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Everything checkUpdate and the move rules read off the stored row.
const STORED_FOR_CHECK = {
  id: true, name: true, venue: true, latitude: true, longitude: true, concert_date: true,
  source: true, metadata: true, festival: true,
  on_sale: true, sold_out: true, ticket_sale_start: true,
  price_min: true, price_max: true, price_currency: true,
  ticket_vendors: true, event_status: true,
};

// POST /follows/checks — what the checker read, one entry per show
router.post(
  "/follows/checks",
  [
    auth,
    roleCheck(["ADMIN", "SYSTEM"]),
    body("checks").isArray({ min: 1, max: MAX_LIMIT }).withMessage(`checks must be an array of 1 to ${MAX_LIMIT}`),
    body("checks.*.concert_id").isInt({ min: 1 }).withMessage("Every check needs a concert_id"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const now = new Date();
    let checked = 0;
    let failed = 0;
    let missing = 0;
    const changed = [];

    for (const check of req.body.checks) {
      const concertId = parseInt(check.concert_id, 10);
      try {
        const stored = await prisma.concert.findUnique({ where: { id: concertId }, select: STORED_FOR_CHECK });
        // Deleted between the pending read and now: nothing to write to.
        if (!stored) {
          missing++;
          continue;
        }

        if (check.ok !== true) {
          // Tried, and counted against it: the cadence backs off on a run of
          // these, and the admin panel says which show and why.
          await prisma.concert.update({
            where: { id: concertId },
            data: {
              ticket_check_attempted_at: now,
              ticket_check_failures: { increment: 1 },
              ticket_check_error: String(check.error || "unknown error").slice(0, ERROR_MAX),
            },
          });
          failed++;
          continue;
        }

        const news = checkUpdate(stored, check, now);
        await prisma.concert.update({
          where: { id: concertId },
          data: {
            ...news,
            tickets_checked_at: now,
            ticket_check_attempted_at: now,
            ticket_check_failures: 0,
            ticket_check_error: null,
          },
        });
        checked++;
        if (Object.keys(news).length > 0) changed.push({ concert_id: concertId, fields: Object.keys(news) });
      } catch (error) {
        console.error(`[followChecks] Could not record the check of concert ${concertId}:`, error.message);
        failed++;
      }
    }

    // Told now, not on the alert cron's next turn: the five-minute checks are
    // for the minutes around a sale opening, and five more of them would undo
    // the point. Only when something moved — the cron covers the reminders.
    let alerts = null;
    if (changed.length > 0) {
      try {
        const result = await runTicketAlertsSerially({ now });
        alerts = { alerted: result.alerted, failed: result.failed };
      } catch (error) {
        console.error("[followChecks] Ticket alerts failed after a check:", error);
      }
    }

    res.json({ checked, failed, missing, changed, alerts });
  }
);

module.exports = router;
