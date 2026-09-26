const express = require("express");
const router = express.Router({ mergeParams: true });
const { param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const ownsTrip = require("../../middlewares/ownsTrip");
const prisma = require("../../prisma/client");
const { fail } = require("../../utils/apiResponse");
const { normaliseEstimateInput } = require("../../utils/travel/estimateInput");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));
router.use(ownsTrip);

// GET /travel/trips/:tripId/estimates
router.get("/", async (req, res) => {
  try {
    const estimates = await prisma.expenseEstimate.findMany({
      where: { trip_id: req.tripId },
      orderBy: [{ sort_order: "asc" }, { created_at: "asc" }],
    });
    res.json({ data: estimates });
  } catch (err) {
    fail(res, err, { context: `GET estimates (trip ${req.tripId})` });
  }
});

// POST /travel/trips/:tripId/estimates
router.post("/", async (req, res) => {
  const { data, error } = normaliseEstimateInput(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const estimate = await prisma.expenseEstimate.create({ data: { ...data, trip_id: req.tripId } });
    res.status(201).json({ data: estimate });
  } catch (err) {
    fail(res, err, { context: `POST estimate (trip ${req.tripId})` });
  }
});

// PATCH /travel/trips/:tripId/estimates/:estimateId
router.patch("/:estimateId", param("estimateId").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid parameters" });

  const { data, error } = normaliseEstimateInput(req.body, { partial: true });
  if (error) return res.status(400).json({ error });

  try {
    const estimate = await prisma.expenseEstimate.update({
      where: { id: parseInt(req.params.estimateId, 10), trip_id: req.tripId },
      data,
    });
    res.json({ data: estimate });
  } catch (err) {
    fail(res, err, { context: `PATCH estimate ${req.params.estimateId}`, notFound: "Estimate not found" });
  }
});

// DELETE /travel/trips/:tripId/estimates/:estimateId
router.delete("/:estimateId", param("estimateId").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid parameters" });

  try {
    await prisma.expenseEstimate.delete({
      where: { id: parseInt(req.params.estimateId, 10), trip_id: req.tripId },
    });
    res.json({ message: "Estimate deleted" });
  } catch (err) {
    fail(res, err, { context: `DELETE estimate ${req.params.estimateId}`, notFound: "Estimate not found" });
  }
});

module.exports = router;
