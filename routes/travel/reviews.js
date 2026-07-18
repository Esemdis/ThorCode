const express = require("express");
const router = express.Router({ mergeParams: true });
const { body, param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");
const { recomputeGearReviewStatus } = require("../../utils/reviewStatus");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));

const VALID_USAGE = ["NEVER", "SOMETIMES", "OFTEN"];
const VALID_VERDICTS = ["KEEP", "REPLACE", "DITCH"];
const VALID_QUANTITIES = ["TOO_FEW", "RIGHT", "TOO_MANY"];

async function ownsTrip(userId, tripId) {
  const trip = await prisma.trip.findFirst({ where: { id: tripId, user_id: userId } });
  return !!trip;
}

// GET /travel/trips/:tripId/reviews — all reviews for a trip
router.get("/", param("tripId").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid tripId" });

  const tripId = parseInt(req.params.tripId);
  if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

  try {
    const reviews = await prisma.itemReview.findMany({
      where: { trip_id: tripId },
      orderBy: { created_at: "asc" },
    });
    res.json({ data: reviews });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /travel/trips/:tripId/reviews — create/update the review for one trip item.
// Body: { trip_item_id, usage, rating, verdict, quantity?, note?, add_to_gear? }
// add_to_gear: for ad-hoc items, also create a gear catalog entry and link it.
router.post(
  "/",
  [
    param("tripId").isInt(),
    body("trip_item_id").isInt(),
    body("usage").optional({ nullable: true }).isIn(VALID_USAGE),
    body("rating").optional({ nullable: true }).isInt({ min: 1, max: 5 }),
    body("verdict").isIn(VALID_VERDICTS),
    body("quantity").optional({ nullable: true }).isIn(VALID_QUANTITIES),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const tripId = parseInt(req.params.tripId);
    if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

    const { trip_item_id, usage, rating, verdict, quantity, note, add_to_gear } = req.body;
    try {
      const item = await prisma.tripItem.findFirst({
        where: { id: parseInt(trip_item_id), trip_id: tripId },
      });
      if (!item) return res.status(404).json({ error: "Trip item not found" });

      let gearItemId = item.gear_item_id;
      let createdGearItem = null;
      if (!gearItemId && add_to_gear) {
        createdGearItem = await prisma.gearItem.create({
          data: {
            user_id: req.user.id,
            name: item.name,
            category: item.category,
            url: item.url,
            worn: item.worn,
          },
        });
        gearItemId = createdGearItem.id;
        await prisma.tripItem.update({
          where: { id: item.id },
          data: { gear_item_id: gearItemId },
        });
      }

      const reviewData = {
        usage: usage || null,
        rating: rating != null ? parseInt(rating) : null,
        verdict,
        quantity: quantity || null,
        note: note?.trim() || null,
        item_name: item.name,
        gear_item_id: gearItemId,
      };
      const review = await prisma.itemReview.upsert({
        where: { trip_id_trip_item_id: { trip_id: tripId, trip_item_id: item.id } },
        create: {
          user_id: req.user.id,
          trip_id: tripId,
          trip_item_id: item.id,
          ...reviewData,
        },
        update: reviewData,
      });

      let gearItem = null;
      if (gearItemId) gearItem = await recomputeGearReviewStatus(gearItemId);

      res.status(201).json({ data: { review, gear_item: gearItem, created_gear_item: createdGearItem } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// POST /travel/trips/:tripId/reviews/essential — mark an item as always essential.
// Locks the gear item in immediately, skipping the 3-trip streak. Creates a gear
// catalog entry first if the trip item is ad-hoc.
router.post(
  "/essential",
  [param("tripId").isInt(), body("trip_item_id").isInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const tripId = parseInt(req.params.tripId);
    if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

    try {
      const item = await prisma.tripItem.findFirst({
        where: { id: parseInt(req.body.trip_item_id), trip_id: tripId },
      });
      if (!item) return res.status(404).json({ error: "Trip item not found" });

      let createdGearItem = null;
      let gearItemId = item.gear_item_id;
      if (!gearItemId) {
        createdGearItem = await prisma.gearItem.create({
          data: {
            user_id: req.user.id,
            name: item.name,
            category: item.category,
            url: item.url,
            worn: item.worn,
            essential: true,
            review_status: "LOCKED",
          },
        });
        gearItemId = createdGearItem.id;
        await prisma.tripItem.update({
          where: { id: item.id },
          data: { gear_item_id: gearItemId },
        });
      } else {
        await prisma.gearItem.update({
          where: { id: gearItemId },
          data: { essential: true },
        });
      }

      const gearItem = await recomputeGearReviewStatus(gearItemId);
      res.status(201).json({ data: { gear_item: gearItem, created_gear_item: createdGearItem, trip_item_id: item.id } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// DELETE /travel/trips/:tripId/reviews/:reviewId — remove a review (re-opens the item)
router.delete("/:reviewId", [param("tripId").isInt(), param("reviewId").isInt()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  const tripId = parseInt(req.params.tripId);
  if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

  try {
    const review = await prisma.itemReview.findFirst({
      where: { id: parseInt(req.params.reviewId), trip_id: tripId },
    });
    if (!review) return res.status(404).json({ error: "Review not found" });

    await prisma.itemReview.delete({ where: { id: review.id } });
    let gearItem = null;
    if (review.gear_item_id) gearItem = await recomputeGearReviewStatus(review.gear_item_id);
    res.json({ message: "Review deleted", data: { gear_item: gearItem } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
