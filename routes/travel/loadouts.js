const express = require("express");
const router = express.Router();
const { body, param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));

function flattenSubtree(gearItemId, allItems) {
  const result = [];
  const queue = [gearItemId];
  while (queue.length) {
    const id = queue.shift();
    const item = allItems.find((g) => g.id === id);
    if (item) {
      result.push(item);
      allItems.filter((g) => g.parent_id === id).forEach((child) => queue.push(child.id));
    }
  }
  return result;
}

// GET /travel/loadouts
router.get("/", async (req, res) => {
  try {
    const loadouts = await prisma.loadout.findMany({
      where: { user_id: req.user.id },
      orderBy: { name: "asc" },
      include: {
        entries: {
          include: {
            gear_item_rel: {
              select: { id: true, name: true, brand: true, model: true, category: true, parent_id: true },
            },
          },
          orderBy: { created_at: "asc" },
        },
      },
    });
    res.json({ data: loadouts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /travel/loadouts
router.post("/", [body("name").notEmpty().trim()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const { name, description } = req.body;
  try {
    const loadout = await prisma.loadout.create({
      data: { user_id: req.user.id, name: name.trim(), description: description?.trim() || null },
      include: { entries: true },
    });
    res.status(201).json({ data: loadout });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /travel/loadouts/:id
router.patch("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  const { name, description } = req.body;
  const data = {};
  if (name !== undefined) data.name = name.trim();
  if (description !== undefined) data.description = description?.trim() || null;

  try {
    const existing = await prisma.loadout.findFirst({
      where: { id: parseInt(req.params.id), user_id: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Loadout not found" });

    const loadout = await prisma.loadout.update({ where: { id: parseInt(req.params.id) }, data });
    res.json({ data: loadout });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /travel/loadouts/:id
router.delete("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  try {
    const existing = await prisma.loadout.findFirst({
      where: { id: parseInt(req.params.id), user_id: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Loadout not found" });

    await prisma.loadout.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ message: "Loadout deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /travel/loadouts/:id/entries — add gear item to loadout
router.post(
  "/:id/entries",
  [param("id").isInt(), body("gear_item_id").isInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const loadoutId = parseInt(req.params.id);
    const gearItemId = parseInt(req.body.gear_item_id);

    try {
      const [loadout, gearItem] = await Promise.all([
        prisma.loadout.findFirst({ where: { id: loadoutId, user_id: req.user.id } }),
        prisma.gearItem.findFirst({ where: { id: gearItemId, user_id: req.user.id } }),
      ]);
      if (!loadout) return res.status(404).json({ error: "Loadout not found" });
      if (!gearItem) return res.status(404).json({ error: "Gear item not found" });

      const entry = await prisma.loadoutEntry.upsert({
        where: { loadout_id_gear_item_id: { loadout_id: loadoutId, gear_item_id: gearItemId } },
        create: { loadout_id: loadoutId, gear_item_id: gearItemId },
        update: {},
        include: {
          gear_item_rel: {
            select: { id: true, name: true, brand: true, model: true, category: true, parent_id: true },
          },
        },
      });
      res.status(201).json({ data: entry });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// DELETE /travel/loadouts/:id/entries/:gearItemId — remove gear item from loadout
router.delete(
  "/:id/entries/:gearItemId",
  [param("id").isInt(), param("gearItemId").isInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

    const loadoutId = parseInt(req.params.id);
    const gearItemId = parseInt(req.params.gearItemId);

    try {
      const loadout = await prisma.loadout.findFirst({
        where: { id: loadoutId, user_id: req.user.id },
      });
      if (!loadout) return res.status(404).json({ error: "Loadout not found" });

      await prisma.loadoutEntry.deleteMany({
        where: { loadout_id: loadoutId, gear_item_id: gearItemId },
      });
      res.json({ message: "Entry removed" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// POST /travel/loadouts/:id/apply/:tripId — apply loadout to a trip
router.post(
  "/:id/apply/:tripId",
  [param("id").isInt(), param("tripId").isInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

    const loadoutId = parseInt(req.params.id);
    const tripId = parseInt(req.params.tripId);

    try {
      const [loadout, trip, allGear] = await Promise.all([
        prisma.loadout.findFirst({
          where: { id: loadoutId, user_id: req.user.id },
          include: { entries: { include: { gear_item_rel: true } } },
        }),
        prisma.trip.findFirst({ where: { id: tripId, user_id: req.user.id } }),
        prisma.gearItem.findMany({ where: { user_id: req.user.id } }),
      ]);

      if (!loadout) return res.status(404).json({ error: "Loadout not found" });
      if (!trip) return res.status(404).json({ error: "Trip not found" });

      // Expand each entry: if it's a container, include all descendants
      const seen = new Set();
      const toAdd = [];
      for (const entry of loadout.entries) {
        const subtree = flattenSubtree(entry.gear_item_id, allGear);
        for (const gearItem of subtree) {
          if (seen.has(gearItem.id)) continue;
          seen.add(gearItem.id);
          toAdd.push({
            trip_id: tripId,
            name: gearItem.name,
            category: gearItem.category || null,
            gear_item_id: gearItem.id,
            status: "PACKED",
          });
        }
      }

      const created = await prisma.$transaction(
        toAdd.map((item) => prisma.tripItem.create({ data: item }))
      );

      res.json({ data: { added: created.length, items: created } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
