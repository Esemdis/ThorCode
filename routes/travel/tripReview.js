const express = require("express");
const router = express.Router({ mergeParams: true });
const { body, param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));

async function ownsTrip(userId, tripId) {
  const trip = await prisma.trip.findFirst({ where: { id: tripId, user_id: userId } });
  return !!trip;
}

// GET /travel/trips/:tripId/trip-review — the trip-level review, if any
router.get("/", param("tripId").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid tripId" });

  const tripId = parseInt(req.params.tripId);
  if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

  try {
    const review = await prisma.tripReview.findUnique({ where: { trip_id: tripId } });
    res.json({ data: review });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /travel/trips/:tripId/trip-review — create/update the trip-level review.
// Body: { culture_rating?, culture_note?, food_rating?, food_note?, fun_rating?,
//         fun_note?, missing_gear_item_ids?, missing_note?, comment? }
router.post(
  "/",
  [
    param("tripId").isInt(),
    body("culture_rating").optional({ nullable: true }).isInt({ min: 1, max: 5 }),
    body("food_rating").optional({ nullable: true }).isInt({ min: 1, max: 5 }),
    body("fun_rating").optional({ nullable: true }).isInt({ min: 1, max: 5 }),
    body("missing_gear_item_ids").optional().isArray(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const tripId = parseInt(req.params.tripId);
    if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

    const {
      culture_rating, culture_note, food_rating, food_note,
      fun_rating, fun_note, missing_gear_item_ids, missing_note, comment,
    } = req.body;

    const data = {
      culture_rating: culture_rating != null ? parseInt(culture_rating) : null,
      culture_note: culture_note?.trim() || null,
      food_rating: food_rating != null ? parseInt(food_rating) : null,
      food_note: food_note?.trim() || null,
      fun_rating: fun_rating != null ? parseInt(fun_rating) : null,
      fun_note: fun_note?.trim() || null,
      missing_gear_item_ids: Array.isArray(missing_gear_item_ids)
        ? missing_gear_item_ids.map((id) => parseInt(id)).filter((id) => !Number.isNaN(id))
        : [],
      missing_note: missing_note?.trim() || null,
      comment: comment?.trim() || null,
    };

    try {
      const review = await prisma.tripReview.upsert({
        where: { trip_id: tripId },
        create: { user_id: req.user.id, trip_id: tripId, ...data },
        update: data,
      });
      res.status(201).json({ data: review });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
