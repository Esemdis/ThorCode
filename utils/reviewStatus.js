const prisma = require("../prisma/client");

// A "good" review counts toward the lock-in streak; a "bad" latest review flags the item.
// Rating is optional (swipe reviews record only a verdict): an unrated KEEP counts as
// good, an explicit low rating disqualifies it.
const isGood = (r) => r.verdict === "KEEP" && (r.rating == null || r.rating >= 4);
const isBad = (r) => r.verdict !== "KEEP" || (r.rating != null && r.rating <= 2);

// Recompute streak/lock/flag state for a gear item from its full review history,
// in trip chronological order. 3 consecutive good reviews → LOCKED; latest bad → FLAGGED.
// Items marked essential are always LOCKED regardless of review history.
async function recomputeGearReviewStatus(gearItemId) {
  const gear = await prisma.gearItem.findUnique({ where: { id: gearItemId } });
  if (!gear) return null;

  const reviews = await prisma.itemReview.findMany({
    where: { gear_item_id: gearItemId },
    orderBy: [{ trip_rel: { start_date: "asc" } }, { created_at: "asc" }],
  });

  let streak = 0;
  for (let i = reviews.length - 1; i >= 0; i--) {
    if (isGood(reviews[i])) streak++;
    else break;
  }
  const latest = reviews[reviews.length - 1] || null;

  let status = null;
  if (gear.essential || streak >= 3) status = "LOCKED";
  else if (latest && isBad(latest)) status = "FLAGGED";

  return prisma.gearItem.update({
    where: { id: gearItemId },
    data: {
      review_status: status,
      review_streak: streak,
      review_count: reviews.length,
      last_review_at: latest ? latest.created_at : null,
    },
  });
}

module.exports = { recomputeGearReviewStatus };
