/**
 * A wishlist's activity feed.
 *
 * Out of routes/data/wishlists/shared.js so the scraper's ingest can write
 * through it too: it wrote sold-out entries straight to the table, and those
 * were the one kind that never let the oldest fall off the end.
 */
const prisma = require("../prisma/client");

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

module.exports = { logActivity, ACTIVITY_KEPT };
