const express = require("express");
const router = express.Router();
const { body, param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");
const { fail, paginate, sendList } = require("../../utils/apiResponse");
const { recomputeGearReviewStatus } = require("../../utils/reviewStatus");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));

// Photos arrive as client-side-compressed data URLs; cap ~300KB of string
const PHOTO_MAX_LENGTH = 300000;
function invalidPhoto(photo) {
  if (photo == null) return null;
  if (typeof photo !== "string" || !photo.startsWith("data:image/")) return "Photo must be an image data URL";
  if (photo.length > PHOTO_MAX_LENGTH) return "Photo too large — compress it below ~220KB";
  return null;
}

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
  const { take, skip } = paginate(req, { defaultLimit: 250, maxLimit: 500 });
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
        orderBy: [{ category: "asc" }, { brand: "asc" }, { name: "asc" }],
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
router.post("/", body("name").notEmpty().trim(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const { name, model, brand, category, dimensions, tags, notes, url, worn, photo, retail_price, bought_for, currency, fill_level, price_irrelevant } = req.body;
  const photoError = invalidPhoto(photo);
  if (photoError) return res.status(400).json({ error: photoError });
  try {
    const item = await prisma.gearItem.create({
      data: {
        user_id: req.user.id,
        photo: photo || null,
        name: name.trim(),
        model: model?.trim() || null,
        brand: brand?.trim() || null,
        category: category?.trim() || null,
        dimensions: dimensions ?? null,
        tags: Array.isArray(tags) ? tags.map((t) => t.trim()).filter(Boolean) : [],
        notes: notes?.trim() || null,
        url: url?.trim() || null,
        worn: Boolean(worn),
        retail_price: retail_price != null && retail_price !== "" ? parseFloat(retail_price) : null,
        bought_for: bought_for != null && bought_for !== "" ? parseFloat(bought_for) : null,
        currency: currency?.trim().toUpperCase() || "SEK",
        fill_level: fill_level != null && fill_level !== "" ? Math.max(0, Math.min(100, parseInt(fill_level, 10))) : null,
        price_irrelevant: Boolean(price_irrelevant),
      },
    });
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

  const { name, model, brand, category, dimensions, tags, notes, url, worn, essential, retired, replaced_by_id, photo, retail_price, bought_for, currency, fill_level, price_irrelevant } = req.body;
  const data = {};
  if (photo !== undefined) {
    const photoError = invalidPhoto(photo);
    if (photoError) return res.status(400).json({ error: photoError });
    data.photo = photo || null;
  }
  if (essential !== undefined) data.essential = Boolean(essential);
  if (retired !== undefined) data.retired = Boolean(retired);
  if (replaced_by_id !== undefined) data.replaced_by_id = replaced_by_id != null ? parseInt(replaced_by_id, 10) : null;
  if (name !== undefined) data.name = name.trim();
  if (model !== undefined) data.model = model?.trim() || null;
  if (brand !== undefined) data.brand = brand?.trim() || null;
  if (category !== undefined) data.category = category?.trim() || null;
  if (dimensions !== undefined) data.dimensions = dimensions ?? null;
  if (tags !== undefined) data.tags = Array.isArray(tags) ? tags.map((t) => t.trim()).filter(Boolean) : [];
  if (notes !== undefined) data.notes = notes?.trim() || null;
  if (url !== undefined) data.url = url?.trim() || null;
  if (req.body.sort_order !== undefined) data.sort_order = parseInt(req.body.sort_order, 10);
  if (worn !== undefined) data.worn = Boolean(worn);
  if (retail_price !== undefined) data.retail_price = retail_price != null && retail_price !== "" ? parseFloat(retail_price) : null;
  if (bought_for !== undefined) data.bought_for = bought_for != null && bought_for !== "" ? parseFloat(bought_for) : null;
  if (currency !== undefined) data.currency = currency?.trim().toUpperCase() || "SEK";
  if (fill_level !== undefined) data.fill_level = fill_level != null && fill_level !== "" ? Math.max(0, Math.min(100, parseInt(fill_level, 10))) : null;
  if (price_irrelevant !== undefined) data.price_irrelevant = Boolean(price_irrelevant);

  // Fields that describe "the same product" and should stay in sync across every
  // identical copy (same name+brand+model) a user owns. Per-copy realities — fill
  // level, worn, sort position, essential/retired/review status — are excluded.
  const SYNCED_FIELDS = ["name", "model", "brand", "category", "dimensions", "tags", "notes", "url", "photo", "retail_price", "bought_for", "currency", "price_irrelevant"];

  try {
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
      ]);
      item = updated;
    } else {
      item = await prisma.gearItem.update({
        where: { id: parseInt(req.params.id, 10), user_id: req.user.id },
        data,
      });
    }
    if (essential !== undefined) item = await recomputeGearReviewStatus(item.id);
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
