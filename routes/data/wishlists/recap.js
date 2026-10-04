/**
 * The weekly recap: how many shows by your bands were added in a week, by
 * city, and the same posted to the wishlist's Discord webhook.
 *
 * The counting is utils/weeklyRecap.js, which the Monday cron also runs, so
 * what the tab shows and what the post says are the same numbers.
 */
const express = require("express");
const router = express.Router();
const { validationResult, param, query, body } = require("express-validator");
const auth = require("../../../auth/verifyJWT");
const roleCheck = require("../../../middlewares/roleCheck");
const { rateLimiter } = require("../../../utils/rateLimiter");
const { isTimeZone, weeklyRecap, postRecap } = require("../../../utils/weeklyRecap");
const { ownWishlist } = require("./shared");

// Ten years back is further than anyone pages, and a bound keeps a typo from
// asking for the week of year 0.
const MAX_WEEKS_AGO = 520;

// Its own budget rather than the wishlist one: a post goes to Discord, which
// rate-limits a webhook itself and answers a burst with 429s for a while.
const sendLimit = rateLimiter({ max: 5, message: "Too many recaps sent at once, please try again shortly." });

// The week is asked for in the query on a read and in the body on a send.
const weekChecks = (where) => [
  where("tz").optional().custom(isTimeZone).withMessage("tz must be an IANA time zone, e.g. Europe/Stockholm"),
  where("weeks_ago").optional().isInt({ min: 0, max: MAX_WEEKS_AGO }).withMessage(`weeks_ago must be 0 to ${MAX_WEEKS_AGO}`),
];

function invalid(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ error: errors.array()[0].msg, details: errors.array() });
  return true;
}

const recapFor = (wishlist, source) => weeklyRecap(wishlist.bands, {
  timeZone: source.tz ?? "UTC",
  weeksAgo: source.weeks_ago === undefined ? 0 : Number(source.weeks_ago),
});

const WISHLIST_SELECT = {
  discord_webhook: true,
  bands: { select: { band_id: true, tier: true } },
};

// GET /wishlists/:id/weekly — one week's new concerts, counted by city
router.get(
  "/wishlists/:id/weekly",
  [auth, roleCheck(["ADMIN", "USER"]), param("id").isInt().withMessage("Wishlist ID must be an integer"), ...weekChecks(query)],
  async (req, res) => {
    try {
      if (invalid(req, res)) return;
      const wishlist = await ownWishlist(req, res, { select: WISHLIST_SELECT });
      if (!wishlist) return;

      const recap = await recapFor(wishlist, req.query);
      // Whether there is a webhook, never the webhook: it is a credential.
      res.json({ ...recap, discord: Boolean(wishlist.discord_webhook) });
    } catch (error) {
      console.error("Error building weekly recap:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

// POST /wishlists/:id/weekly/discord — post one week's recap to the wishlist's webhook
router.post(
  "/wishlists/:id/weekly/discord",
  [auth, roleCheck(["ADMIN", "USER"]), sendLimit, param("id").isInt().withMessage("Wishlist ID must be an integer"), ...weekChecks(body)],
  async (req, res) => {
    try {
      if (invalid(req, res)) return;
      const wishlist = await ownWishlist(req, res, { select: WISHLIST_SELECT });
      if (!wishlist) return;
      if (!wishlist.discord_webhook) {
        return res.status(409).json({ error: "This wishlist has no Discord webhook to post to." });
      }

      const recap = await recapFor(wishlist, req.body);
      if (recap.total === 0) {
        return res.status(409).json({ error: "No new concerts that week, so there is nothing to post." });
      }

      try {
        await postRecap(wishlist.discord_webhook, recap);
      } catch (error) {
        console.error(`[weeklyRecap] Discord refused wishlist ${wishlist.id}'s recap:`, error.response?.status ?? error.message);
        return res.status(502).json({ error: "Discord did not take the post. Check the webhook still exists." });
      }
      res.json({ sent: true, total: recap.total });
    } catch (error) {
      console.error("Error sending weekly recap:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

module.exports = router;
// For the tests, which would otherwise spend it for each other.
module.exports.sendLimit = sendLimit;
