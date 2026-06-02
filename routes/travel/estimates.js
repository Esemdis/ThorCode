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

// GET /travel/trips/:tripId/estimates
router.get("/", param("tripId").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid tripId" });

  const tripId = parseInt(req.params.tripId);
  if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

  try {
    const estimates = await prisma.expenseEstimate.findMany({
      where: { trip_id: tripId },
      orderBy: [{ sort_order: "asc" }, { created_at: "asc" }],
    });
    res.json({ data: estimates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /travel/trips/:tripId/estimates
router.post(
  "/",
  [
    param("tripId").isInt(),
    body("category").notEmpty().trim(),
    body("amount").isDecimal(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const tripId = parseInt(req.params.tripId);
    if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

    const { category, amount, currency, note, sort_order } = req.body;
    try {
      const estimate = await prisma.expenseEstimate.create({
        data: {
          trip_id: tripId,
          category: category.trim(),
          amount: parseFloat(amount),
          currency: currency?.toUpperCase() || "SEK",
          note: note?.trim() || null,
          sort_order: sort_order ?? 0,
        },
      });
      res.status(201).json({ data: estimate });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// PATCH /travel/trips/:tripId/estimates/:estimateId
router.patch(
  "/:estimateId",
  [param("tripId").isInt(), param("estimateId").isInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid parameters" });

    const tripId = parseInt(req.params.tripId);
    const estimateId = parseInt(req.params.estimateId);
    if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

    const { category, amount, currency, note, sort_order } = req.body;
    const data = {};
    if (category !== undefined) data.category = category.trim();
    if (amount !== undefined) data.amount = parseFloat(amount);
    if (currency !== undefined) data.currency = currency.toUpperCase();
    if (note !== undefined) data.note = note?.trim() || null;
    if (sort_order !== undefined) data.sort_order = sort_order;

    try {
      const existing = await prisma.expenseEstimate.findFirst({
        where: { id: estimateId, trip_id: tripId },
      });
      if (!existing) return res.status(404).json({ error: "Estimate not found" });

      const estimate = await prisma.expenseEstimate.update({ where: { id: estimateId }, data });
      res.json({ data: estimate });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// DELETE /travel/trips/:tripId/estimates/:estimateId
router.delete(
  "/:estimateId",
  [param("tripId").isInt(), param("estimateId").isInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid parameters" });

    const tripId = parseInt(req.params.tripId);
    const estimateId = parseInt(req.params.estimateId);
    if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

    try {
      const existing = await prisma.expenseEstimate.findFirst({
        where: { id: estimateId, trip_id: tripId },
      });
      if (!existing) return res.status(404).json({ error: "Estimate not found" });

      await prisma.expenseEstimate.delete({ where: { id: estimateId } });
      res.json({ message: "Estimate deleted" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
