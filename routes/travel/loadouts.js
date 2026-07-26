const express = require("express");
const router = express.Router();
const { body, param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");
const { fail } = require("../../utils/apiResponse");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));

const ENTRY_GEAR = {
  gear_item_rel: {
    select: { id: true, name: true, brand: true, model: true, category: true, photo: true },
  },
};

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
              select: { id: true, name: true, brand: true, model: true, category: true, dimensions: true, photo: true },
            },
          },
          orderBy: { created_at: "asc" },
        },
      },
    });
    res.json({ data: loadouts });
  } catch (err) {
    fail(res, err, { context: "GET loadouts" });
  }
});

// POST /travel/loadouts
router.post("/", body("name").notEmpty().trim(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const { name, description, weight_budget } = req.body;
  try {
    const loadout = await prisma.loadout.create({
      data: {
        user_id: req.user.id,
        name: name.trim(),
        description: description?.trim() || null,
        weight_budget: weight_budget != null ? parseInt(weight_budget, 10) : null,
      },
      include: { entries: true },
    });
    res.status(201).json({ data: loadout });
  } catch (err) {
    fail(res, err, { context: "POST loadout" });
  }
});

// PATCH /travel/loadouts/:id
router.patch("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  const { name, description, weight_budget } = req.body;
  const data = {};
  if (name !== undefined) data.name = name.trim();
  if (description !== undefined) data.description = description?.trim() || null;
  if (weight_budget !== undefined) data.weight_budget = weight_budget != null ? parseInt(weight_budget, 10) : null;

  try {
    const loadout = await prisma.loadout.update({
      where: { id: parseInt(req.params.id, 10), user_id: req.user.id },
      data,
    });
    res.json({ data: loadout });
  } catch (err) {
    fail(res, err, { context: `PATCH loadout ${req.params.id}`, notFound: "Loadout not found" });
  }
});

// DELETE /travel/loadouts/:id
router.delete("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  try {
    await prisma.loadout.delete({
      where: { id: parseInt(req.params.id, 10), user_id: req.user.id },
    });
    res.json({ message: "Loadout deleted" });
  } catch (err) {
    fail(res, err, { context: `DELETE loadout ${req.params.id}`, notFound: "Loadout not found" });
  }
});

// POST /travel/loadouts/:id/entries — add gear item to loadout
router.post("/:id/entries", [param("id").isInt(), body("gear_item_id").isInt()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const loadoutId = parseInt(req.params.id, 10);
  const gearItemId = parseInt(req.body.gear_item_id, 10);

  try {
    // Both sides are checked up front rather than folded into the write: an
    // upsert's `create` branch ignores the where clause, so a filter alone
    // would happily create an entry on someone else's loadout.
    const [loadout, gearItem] = await Promise.all([
      prisma.loadout.findFirst({ where: { id: loadoutId, user_id: req.user.id }, select: { id: true } }),
      prisma.gearItem.findFirst({ where: { id: gearItemId, user_id: req.user.id }, select: { id: true } }),
    ]);
    if (!loadout) return res.status(404).json({ error: "Loadout not found" });
    if (!gearItem) return res.status(404).json({ error: "Gear item not found" });

    const worn = req.body.worn === true || req.body.worn === "true";
    const entry = await prisma.loadoutEntry.upsert({
      where: { loadout_id_gear_item_id: { loadout_id: loadoutId, gear_item_id: gearItemId } },
      create: { loadout_id: loadoutId, gear_item_id: gearItemId, worn },
      update: req.body.worn !== undefined ? { worn } : {},
      include: ENTRY_GEAR,
    });
    res.status(201).json({ data: entry });
  } catch (err) {
    fail(res, err, { context: `POST loadout entry (loadout ${loadoutId})` });
  }
});

// PATCH /travel/loadouts/:id/entries/:gearItemId — update entry (e.g. toggle worn)
router.patch("/:id/entries/:gearItemId", [param("id").isInt(), param("gearItemId").isInt()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  const loadoutId = parseInt(req.params.id, 10);
  const gearItemId = parseInt(req.params.gearItemId, 10);

  const data = {};
  if (req.body.worn !== undefined) data.worn = Boolean(req.body.worn);
  if (req.body.bag_id !== undefined) data.bag_id = req.body.bag_id != null ? parseInt(req.body.bag_id, 10) : null;

  try {
    // "this entry, and only if its loadout is mine" — one statement.
    const entry = await prisma.loadoutEntry.update({
      where: {
        loadout_id_gear_item_id: { loadout_id: loadoutId, gear_item_id: gearItemId },
        loadout_rel: { user_id: req.user.id },
      },
      data,
      include: ENTRY_GEAR,
    });
    res.json({ data: entry });
  } catch (err) {
    fail(res, err, { context: `PATCH loadout entry (loadout ${loadoutId})`, notFound: "Entry not found" });
  }
});

// DELETE /travel/loadouts/:id/entries/:gearItemId — remove gear item from loadout
router.delete("/:id/entries/:gearItemId", [param("id").isInt(), param("gearItemId").isInt()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  const loadoutId = parseInt(req.params.id, 10);
  try {
    const { count } = await prisma.loadoutEntry.deleteMany({
      where: {
        loadout_id: loadoutId,
        gear_item_id: parseInt(req.params.gearItemId, 10),
        loadout_rel: { user_id: req.user.id },
      },
    });
    if (count === 0) return res.status(404).json({ error: "Entry not found" });
    res.json({ message: "Entry removed" });
  } catch (err) {
    fail(res, err, { context: `DELETE loadout entry (loadout ${loadoutId})` });
  }
});

// POST /travel/loadouts/:id/apply/:tripId — apply loadout to a trip
router.post("/:id/apply/:tripId", [param("id").isInt(), param("tripId").isInt()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  const loadoutId = parseInt(req.params.id, 10);
  const tripId = parseInt(req.params.tripId, 10);

  try {
    const [loadout, trip] = await Promise.all([
      prisma.loadout.findFirst({
        where: { id: loadoutId, user_id: req.user.id },
        include: { entries: { include: { gear_item_rel: true } } },
      }),
      prisma.trip.findFirst({ where: { id: tripId, user_id: req.user.id }, select: { id: true } }),
    ]);

    if (!loadout) return res.status(404).json({ error: "Loadout not found" });
    if (!trip) return res.status(404).json({ error: "Trip not found" });

    const toAdd = loadout.entries.map((entry) => ({
      trip_id: tripId,
      name: entry.gear_item_rel.name,
      category: entry.gear_item_rel.category || null,
      gear_item_id: entry.gear_item_id,
      status: "BOUGHT",
      worn: entry.worn || false,
      bag_id: entry.bag_id || null,
    }));

    const created = await prisma.$transaction(
      toAdd.map((item) => prisma.tripItem.create({ data: item }))
    );

    res.json({ data: { added: created.length, items: created } });
  } catch (err) {
    fail(res, err, { context: `POST apply loadout ${loadoutId} to trip ${tripId}` });
  }
});

// POST /travel/loadouts/:id/duplicate — clone a loadout with all its entries
router.post("/:id/duplicate", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  const id = parseInt(req.params.id, 10);
  try {
    const source = await prisma.loadout.findFirst({
      where: { id, user_id: req.user.id },
      include: { entries: true },
    });
    if (!source) return res.status(404).json({ error: "Loadout not found" });

    const copy = await prisma.loadout.create({
      data: {
        user_id: req.user.id,
        name: `${source.name} (copy)`,
        description: source.description,
        weight_budget: source.weight_budget,
        entries: {
          create: source.entries.map((e) => ({ gear_item_id: e.gear_item_id, worn: e.worn, bag_id: e.bag_id })),
        },
      },
      include: {
        entries: {
          include: {
            gear_item_rel: {
              select: { id: true, name: true, brand: true, model: true, category: true, dimensions: true, photo: true },
            },
          },
          orderBy: { created_at: "asc" },
        },
      },
    });

    res.status(201).json({ data: copy });
  } catch (err) {
    fail(res, err, { context: `POST duplicate loadout ${id}` });
  }
});

module.exports = router;
