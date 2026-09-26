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

// How many activity entries a wishlist keeps. The feed shows exactly these.
const ACTIVITY_KEPT = 15;

/**
 * Add an entry to a wishlist's activity feed, and let the oldest fall off the
 * end so the feed stays at ACTIVITY_KEPT.
 *
 * @param {number} wishlistId
 * @param {string} type - an ActivityLog type, e.g. NEW_CONCERTS
 * @param {object} data - stored as JSON text
 */
async function logActivity(wishlistId, type, data) {
  await prisma.activityLog.create({
    data: { wishlist_id: wishlistId, type, data: JSON.stringify(data) },
  });
  const old = await prisma.activityLog.findMany({
    where: { wishlist_id: wishlistId },
    orderBy: { created_at: "desc" },
    skip: ACTIVITY_KEPT,
    select: { id: true },
  });
  if (old.length > 0) {
    await prisma.activityLog.deleteMany({ where: { id: { in: old.map((e) => e.id) } } });
  }
}

module.exports = { rateLimit, ownWishlist, logActivity, ACTIVITY_KEPT };
