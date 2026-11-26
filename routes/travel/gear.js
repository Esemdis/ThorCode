const express = require("express");
const router = express.Router();
const { param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");
const { fail, paginate, sendList } = require("../../utils/apiResponse");
const { recomputeGearReviewStatus } = require("../../utils/reviewStatus");
const { normaliseGearInput } = require("../../utils/travel/gearInput");
const { upgradeCarryOverOps } = require("../../utils/travel/upgradeCarryOver");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));

// Fields that describe "the same product" and should stay in sync across every
// identical copy (same name+brand+model) a user owns. Per-copy realities — fill
// level, worn, sort position, essential/retired/review status — are excluded.
const SYNCED_FIELDS = ["name", "model", "brand", "category", "dimensions", "tags", "notes", "url", "photo", "retail_price", "bought_for", "currency", "price_irrelevant"];

// GET /travel/gear/usage-stats — trip usage summary for all gear items
router.get("/usage-stats", async (req, res) => {
  try {
    const tripItems = await prisma.tripItem.findMany({
      where: {
        gear_item_id: { not: null },
        gear_item_rel: { user_id: req.user.id },
      },
      select: {
        gear_item_id: true,
        trip_rel: { select: { id: true, name: true, destination: true, start_date: true } },
      },
      orderBy: { created_at: "asc" },
    });

    // Build per-gear map: gear_item_id → { trips (deduped by trip id), last_trip }
    const map = new Map();
    for (const ti of tripItems) {
      const gid = ti.gear_item_id;
      if (!map.has(gid)) map.set(gid, { trips: new Map() });
      const entry = map.get(gid);
      const t = ti.trip_rel;
      if (!entry.trips.has(t.id)) entry.trips.set(t.id, t);
    }

    const stats = {};
    for (const [gid, { trips }] of map.entries()) {
      const tripList = [...trips.values()].sort(
        (a, b) => new Date(b.start_date || 0) - new Date(a.start_date || 0)
      );
      stats[gid] = {
        trip_count: tripList.length,
        last_trip: tripList[0] || null,
        trips: tripList,
      };
    }

    res.json({ data: stats });
  } catch (err) {
    fail(res, err, { context: "GET gear usage-stats" });
  }
});

// GET /travel/gear — list all gear items with trip count
router.get("/", async (req, res) => {
  const { take, skip } = paginate(req, { defaultLimit: 500, maxLimit: 500 });
  try {
    const where = { user_id: req.user.id };
    const [gear, total] = await Promise.all([
      prisma.gearItem.findMany({
        where,
        include: {
          _count: { select: { trip_items: true, loadout_entries: true } },
          loadout_entries: { select: { loadout_rel: { select: { id: true, name: true } } } },
          replaced_by_rel: { select: { id: true, name: true, brand: true, model: true } },
        },
        orderBy: [{ category: "asc" }, { brand: "asc" }, { name: "asc" }, { id: "asc" }],
        take,
        skip,
      }),
      prisma.gearItem.count({ where }),
    ]);
    sendList(res, gear, { total, take, skip });
  } catch (err) {
    fail(res, err, { context: "GET gear" });
  }
});

// POST /travel/gear — create gear item
router.post("/", async (req, res) => {
  const { data, error } = normaliseGearInput(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const item = await prisma.gearItem.create({ data: { ...data, user_id: req.user.id } });
    res.status(201).json({ data: item });
  } catch (err) {
    fail(res, err, { context: "POST gear" });
  }
});

// GET /travel/gear/:id — get gear item with trip history
router.get("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  try {
    const item = await prisma.gearItem.findFirst({
      where: { id: parseInt(req.params.id), user_id: req.user.id },
      include: {
        trip_items: {
          include: { trip_rel: { select: { id: true, name: true, destination: true, start_date: true } } },
          orderBy: { created_at: "desc" },
        },
        reviews: {
          include: { trip_rel: { select: { id: true, name: true, destination: true, start_date: true } } },
          orderBy: { created_at: "desc" },
        },
      },
    });
    if (!item) return res.status(404).json({ error: "Gear item not found" });
    res.json({ data: item });
  } catch (err) {
    fail(res, err, { context: `GET gear ${req.params.id}` });
  }
});

// PATCH /travel/gear/:id
router.patch("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  const { data, error } = normaliseGearInput(req.body, { partial: true });
  if (error) return res.status(400).json({ error });
  const { replaced_by_id } = req.body;
  let replacement = null;

  try {
    if (replaced_by_id !== undefined) {
      if (replaced_by_id == null) {
        data.replaced_by_id = null;
      } else {
        const replacedById = parseInt(replaced_by_id, 10);
        if (!Number.isInteger(replacedById)) {
          return res.status(400).json({ error: "replaced_by_id must reference your own gear item" });
        }
        // Replaced by itself is a loop every "what replaced this" walk follows
        // forever.
        if (replacedById === parseInt(req.params.id, 10)) {
          return res.status(400).json({ error: "A gear item cannot replace itself" });
        }
        // Must belong to the same user — otherwise this becomes a link an
        // attacker controls, and reads of their own gear leak the target's name/brand/model.
        replacement = await prisma.gearItem.findFirst({
          where: { id: replacedById, user_id: req.user.id },
          select: { id: true, name: true, category: true },
        });
        if (!replacement) return res.status(400).json({ error: "replaced_by_id must reference your own gear item" });
        data.replaced_by_id = replacedById;
      }
    }

    // An upgrade (retired, with its replacement) swaps the replacement into
    // loadouts and trips still ahead, in the same transaction as the retirement.
    const carryOver = replacement && data.retired === true
      ? upgradeCarryOverOps(prisma, { userId: req.user.id, oldId: parseInt(req.params.id, 10), replacement, now: new Date() })
      : [];

    const syncData = {};
    for (const f of SYNCED_FIELDS) if (f in data) syncData[f] = data[f];

    let item;
    if (Object.keys(syncData).length > 0) {
      // Renaming a copy renames every copy of the same product, which means the
      // siblings have to be found by the identity the row had *before* this
      // update — hence the read. It doubles as the ownership check.
      const existing = await prisma.gearItem.findFirst({
        where: { id: parseInt(req.params.id, 10), user_id: req.user.id },
        select: { id: true, name: true, brand: true, model: true },
      });
      if (!existing) return res.status(404).json({ error: "Gear item not found" });

      const [updated] = await prisma.$transaction([
        prisma.gearItem.update({ where: { id: existing.id }, data }),
        prisma.gearItem.updateMany({
          where: { user_id: req.user.id, id: { not: existing.id }, name: existing.name, brand: existing.brand, model: existing.model },
          data: syncData,
        }),
        ...carryOver,
      ]);
      item = updated;
    } else {
      // Not this user's item: the update throws and the carry-over rolls back.
      [item] = await prisma.$transaction([
        prisma.gearItem.update({
          where: { id: parseInt(req.params.id, 10), user_id: req.user.id },
          data,
        }),
        ...carryOver,
      ]);
    }
    if ("essential" in data) item = await recomputeGearReviewStatus(item.id);
    res.json({ data: item });
  } catch (err) {
    fail(res, err, { context: `PATCH gear ${req.params.id}`, notFound: "Gear item not found" });
  }
});

// DELETE /travel/gear/:id
router.delete("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  try {
    await prisma.gearItem.delete({
      where: { id: parseInt(req.params.id, 10), user_id: req.user.id },
    });
    res.json({ message: "Gear item deleted" });
  } catch (err) {
    fail(res, err, { context: `DELETE gear ${req.params.id}`, notFound: "Gear item not found" });
  }
});

module.exports = router;
