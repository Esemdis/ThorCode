/**
 * What more than one of the wishlist routers needs.
 *
 * The limiter is here rather than built per module for a reason: express-rate-
 * limit keeps its counter inside the instance, so a second one would give those
 * routes a second budget and quietly double the limit a caller actually gets.
 * One instance, imported everywhere, keeps the ceiling where it was.
 */
const { rateLimiter } = require("../../../utils/rateLimiter");
const prisma = require("../../../prisma/client");

// 10 requests a minute per IP — rateLimiter's defaults.
const rateLimit = rateLimiter({
  message: "Too many wishlist changes at once, please try again shortly.",
});

/**
 * The wishlist named by :id, when it is the caller's. Otherwise the refusal is
 * sent from here and the result is null, so every route stops at the same
 * place, with the same words, for the same reasons.
 *
 * Thirteen routes spelled this out for themselves, in two different wordings.
 * The id must already have been validated: this reads it, it does not check it.
 *
 * `select` gains user_id, which the ownership check needs whatever the route
 * asked for. `allowAdmin` lets an admin read someone else's list — only the
 * full wishlist read does that.
 *
 * @param {object} req
 * @param {object} res
 * @param {{ select?: object, include?: object, allowAdmin?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
async function ownWishlist(req, res, { select, include, allowAdmin = false } = {}) {
  const wishlist = await prisma.wishlist.findUnique({
    where: { id: parseInt(req.params.id, 10) },
    ...(select && { select: { ...select, user_id: true } }),
    ...(include && { include }),
  });
  if (!wishlist) {
    res.status(404).json({ error: "Wishlist not found." });
    return null;
  }
  if (wishlist.user_id !== req.user.id && !(allowAdmin && req.user.role === "ADMIN")) {
    res.status(403).json({ error: "That wishlist is not yours." });
    return null;
  }
  return wishlist;
}

/**
 * A wishlist row as the app may see it (THO-966).
 *
 * The answers were the raw row, which sent discord_webhook (anyone holding it
 * can post to that channel as the bot) and calendar_token (it reads the feed
 * without signing in) to concert-map on every load, though it reads neither.
 * A whitelist rather than spreading the row and deleting the two: a column
 * added later stays out until someone decides it belongs here. The calendar
 * token is handed out by calendar.js alone; the webhook only as a yes or no.
 *
 * @param {object} row a wishlist, with its bands included
 * @returns {object}
 */
function toWishlistAnswer(row) {
  return {
    id: row.id,
    name: row.name,
    user_id: row.user_id,
    last_active_at: row.last_active_at,
    calendar_token_at: row.calendar_token_at,
    bands: row.bands,
    has_discord_webhook: Boolean(row.discord_webhook),
  };
}

// Lives in utils/activityLog.js, which the scraper's ingest writes through too.
const { logActivity, ACTIVITY_KEPT } = require("../../../utils/activityLog");

module.exports = { rateLimit, ownWishlist, toWishlistAnswer, logActivity, ACTIVITY_KEPT };
