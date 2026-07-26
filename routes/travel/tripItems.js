const express = require("express");
const router = express.Router({ mergeParams: true });
const { body, param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const ownsTrip = require("../../middlewares/ownsTrip");
const prisma = require("../../prisma/client");
const { fail } = require("../../utils/apiResponse");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));
router.use(ownsTrip);

const VALID_STATUSES = ["NEED_TO_BUY", "BOUGHT", "PACKED", "NOT_PACKED"];

// GET /travel/trips/:tripId/items
router.get("/", async (req, res) => {
  try {
    const items = await prisma.tripItem.findMany({
      where: { trip_id: req.tripId },
      include: { gear_item_rel: true },
      orderBy: [{ sort_order: "asc" }, { created_at: "asc" }],
    });
    res.json({ data: items });
  } catch (err) {
    fail(res, err, { context: `GET items (trip ${req.tripId})` });
  }
});

// POST /travel/trips/:tripId/items
router.post("/", body("name").notEmpty().trim(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const { name, category, status, note, url, sort_order, gear_item_id, worn } = req.body;
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  try {
    // Linking to gear reads the gear row anyway — for its worn flag — so the
    // ownership filter rides along on a query that has to happen regardless.
    let resolvedWorn = worn !== undefined ? Boolean(worn) : false;
    if (gear_item_id) {
      const gear = await prisma.gearItem.findFirst({
        where: { id: parseInt(gear_item_id, 10), user_id: req.user.id },
        select: { worn: true },
      });
      if (!gear) return res.status(404).json({ error: "Gear item not found" });
      if (worn === undefined) resolvedWorn = gear.worn;
    }

    const item = await prisma.tripItem.create({
      data: {
        trip_id: req.tripId,
        name: name.trim(),
        category: category?.trim() || null,
        status: status || "BOUGHT",
        note: note?.trim() || null,
        url: url?.trim() || null,
        sort_order: sort_order ?? 0,
        gear_item_id: gear_item_id ? parseInt(gear_item_id, 10) : null,
        worn: resolvedWorn,
      },
      include: { gear_item_rel: true },
    });
    res.status(201).json({ data: item });
  } catch (err) {
    fail(res, err, { context: `POST item (trip ${req.tripId})` });
  }
});

// PATCH /travel/trips/:tripId/items/reorder — bulk sort_order update.
// Declared before /:itemId so "reorder" isn't read as an item id.
router.patch("/reorder", async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: "items must be an array" });

  try {
    await prisma.$transaction(
      items.map(({ id, sort_order }) =>
        prisma.tripItem.updateMany({
          where: { id, trip_id: req.tripId },
          data: { sort_order },
        })
      )
    );
    res.json({ message: "Reordered" });
  } catch (err) {
    fail(res, err, { context: `PATCH reorder (trip ${req.tripId})` });
  }
});

// PATCH /travel/trips/:tripId/items/:itemId
router.patch("/:itemId", param("itemId").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid parameters" });

  const { name, category, status, note, url, sort_order, gear_item_id, worn } = req.body;
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  const data = {};
  if (name !== undefined) data.name = name.trim();
  if (category !== undefined) data.category = category?.trim() || null;
  if (status !== undefined) data.status = status;
  if (note !== undefined) data.note = note?.trim() || null;
  if (url !== undefined) data.url = url?.trim() || null;
  if (sort_order !== undefined) data.sort_order = sort_order;
  if (gear_item_id !== undefined) data.gear_item_id = gear_item_id ? parseInt(gear_item_id, 10) : null;
  if (worn !== undefined) data.worn = Boolean(worn);

  try {
    const item = await prisma.tripItem.update({
      where: { id: parseInt(req.params.itemId, 10), trip_id: req.tripId },
      data,
      include: { gear_item_rel: true },
    });
    res.json({ data: item });
  } catch (err) {
    fail(res, err, { context: `PATCH item ${req.params.itemId}`, notFound: "Item not found" });
  }
});

// DELETE /travel/trips/:tripId/items/:itemId
router.delete("/:itemId", param("itemId").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid parameters" });

  try {
    await prisma.tripItem.delete({
      where: { id: parseInt(req.params.itemId, 10), trip_id: req.tripId },
    });
    res.json({ message: "Item deleted" });
  } catch (err) {
    fail(res, err, { context: `DELETE item ${req.params.itemId}`, notFound: "Item not found" });
  }
});

module.exports = router;
