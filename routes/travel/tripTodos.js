const express = require("express");
const router = express.Router({ mergeParams: true });
const { body, param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const ownsTrip = require("../../middlewares/ownsTrip");
const prisma = require("../../prisma/client");
const { fail } = require("../../utils/apiResponse");
const { INT32_MAX, INT32_MIN, text: textField, number } = require("../../utils/travel/fields");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));
router.use(ownsTrip);

// Open todos first, then the order they were added — a finished task drops to
// the bottom of the list rather than moving around in it.
const ORDER = [{ done: "asc" }, { sort_order: "asc" }, { created_at: "asc" }];

// A position in the list, or undefined when it is not a whole number — which
// reached Prisma as it came and failed there as a 500.
const position = (value) => number(value, { min: INT32_MIN, max: INT32_MAX, integer: true });

// GET /travel/trips/:tripId/todos
router.get("/", async (req, res) => {
  try {
    const todos = await prisma.tripTodo.findMany({ where: { trip_id: req.tripId }, orderBy: ORDER });
    res.json({ data: todos });
  } catch (err) {
    fail(res, err, { context: `GET todos (trip ${req.tripId})` });
  }
});

// POST /travel/trips/:tripId/todos
router.post("/", body("text").notEmpty().trim().isLength({ max: 300 }), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const { text, done, sort_order } = req.body;
  const sortOrder = position(sort_order);
  if (sortOrder === undefined) return res.status(400).json({ error: "sort_order must be a whole number" });
  try {
    const todo = await prisma.tripTodo.create({
      data: {
        trip_id: req.tripId,
        text: text.trim(),
        done: Boolean(done),
        sort_order: sortOrder ?? 0,
      },
    });
    res.status(201).json({ data: todo });
  } catch (err) {
    fail(res, err, { context: `POST todo (trip ${req.tripId})` });
  }
});

// PATCH /travel/trips/:tripId/todos/:todoId
router.patch("/:todoId", param("todoId").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid parameters" });

  const { text, done, sort_order } = req.body;
  const data = {};
  if (text !== undefined) {
    // Not a string threw on .trim(), outside the try, as a 500.
    const trimmed = textField(text);
    if (trimmed === undefined) return res.status(400).json({ error: "text must be a string" });
    if (!trimmed) return res.status(400).json({ error: "text cannot be empty" });
    data.text = trimmed.slice(0, 300);
  }
  if (done !== undefined) data.done = Boolean(done);
  if (sort_order !== undefined) {
    const sortOrder = position(sort_order);
    if (sortOrder == null) return res.status(400).json({ error: "sort_order must be a whole number" });
    data.sort_order = sortOrder;
  }

  try {
    // trip_id in the where is the ownership check: the trip is already known to
    // belong to the caller, so a todo that isn't on it can't be touched.
    const todo = await prisma.tripTodo.update({
      where: { id: parseInt(req.params.todoId, 10), trip_id: req.tripId },
      data,
    });
    res.json({ data: todo });
  } catch (err) {
    fail(res, err, { context: `PATCH todo ${req.params.todoId}`, notFound: "Todo not found" });
  }
});

// DELETE /travel/trips/:tripId/todos/:todoId
router.delete("/:todoId", param("todoId").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid parameters" });

  try {
    await prisma.tripTodo.delete({
      where: { id: parseInt(req.params.todoId, 10), trip_id: req.tripId },
    });
    res.json({ message: "Todo deleted" });
  } catch (err) {
    fail(res, err, { context: `DELETE todo ${req.params.todoId}`, notFound: "Todo not found" });
  }
});

module.exports = router;
