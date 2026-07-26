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

// Open todos first, then the order they were added — a finished task drops to
// the bottom of the list rather than moving around in it.
const ORDER = [{ done: "asc" }, { sort_order: "asc" }, { created_at: "asc" }];

// GET /travel/trips/:tripId/todos
router.get("/", param("tripId").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid tripId" });

  const tripId = parseInt(req.params.tripId);
  if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

  try {
    const todos = await prisma.tripTodo.findMany({ where: { trip_id: tripId }, orderBy: ORDER });
    res.json({ data: todos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /travel/trips/:tripId/todos
router.post(
  "/",
  [param("tripId").isInt(), body("text").notEmpty().trim().isLength({ max: 300 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const tripId = parseInt(req.params.tripId);
    if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

    const { text, done, sort_order } = req.body;
    try {
      const todo = await prisma.tripTodo.create({
        data: {
          trip_id: tripId,
          text: text.trim(),
          done: Boolean(done),
          sort_order: sort_order ?? 0,
        },
      });
      res.status(201).json({ data: todo });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// PATCH /travel/trips/:tripId/todos/:todoId
router.patch(
  "/:todoId",
  [param("tripId").isInt(), param("todoId").isInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid parameters" });

    const tripId = parseInt(req.params.tripId);
    const todoId = parseInt(req.params.todoId);
    if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

    const { text, done, sort_order } = req.body;
    const data = {};
    if (text !== undefined) {
      if (!text.trim()) return res.status(400).json({ error: "text cannot be empty" });
      data.text = text.trim().slice(0, 300);
    }
    if (done !== undefined) data.done = Boolean(done);
    if (sort_order !== undefined) data.sort_order = sort_order;

    try {
      const existing = await prisma.tripTodo.findFirst({ where: { id: todoId, trip_id: tripId } });
      if (!existing) return res.status(404).json({ error: "Todo not found" });

      const todo = await prisma.tripTodo.update({ where: { id: todoId }, data });
      res.json({ data: todo });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// DELETE /travel/trips/:tripId/todos/:todoId
router.delete(
  "/:todoId",
  [param("tripId").isInt(), param("todoId").isInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid parameters" });

    const tripId = parseInt(req.params.tripId);
    const todoId = parseInt(req.params.todoId);
    if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

    try {
      const existing = await prisma.tripTodo.findFirst({ where: { id: todoId, trip_id: tripId } });
      if (!existing) return res.status(404).json({ error: "Todo not found" });

      await prisma.tripTodo.delete({ where: { id: todoId } });
      res.json({ message: "Todo deleted" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
