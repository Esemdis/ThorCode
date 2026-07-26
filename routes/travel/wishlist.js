const express = require("express");
const router = express.Router();
const { body, param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");
const { fail, paginate, sendList } = require("../../utils/apiResponse");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN", "SYSTEM"]));

// GET /travel/wishlist
router.get("/", async (req, res) => {
  const { take, skip } = paginate(req, { defaultLimit: 250, maxLimit: 500 });
  try {
    const where = { user_id: req.user.id };
    const [items, total] = await Promise.all([
      prisma.travelWishlistItem.findMany({
        where,
        orderBy: [{ bought: "asc" }, { category: "asc" }, { name: "asc" }],
        take,
        skip,
      }),
      prisma.travelWishlistItem.count({ where }),
    ]);
    sendList(res, items, { total, take, skip });
  } catch (err) {
    fail(res, err, { context: "GET wishlist" });
  }
});

// POST /travel/wishlist
router.post("/", body("name").notEmpty().trim(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const { name, brand, model, category, url, notes, price, currency, dimensions, keywords } = req.body;
  try {
    const item = await prisma.travelWishlistItem.create({
      data: {
        user_id: req.user.id,
        name: name.trim(),
        brand: brand?.trim() || null,
        model: model?.trim() || null,
        category: category?.trim() || null,
        url: url?.trim() || null,
        notes: notes?.trim() || null,
        price: price != null ? parseFloat(price) : null,
        currency: currency?.trim() || "SEK",
        dimensions: dimensions || null,
        keywords: Array.isArray(keywords) ? keywords.map((k) => k.trim()).filter(Boolean) : [],
      },
    });
    res.status(201).json({ data: item });
  } catch (err) {
    fail(res, err, { context: "POST wishlist" });
  }
});

// PATCH /travel/wishlist/:id
router.patch("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  const { name, brand, model, category, url, notes, price, currency, dimensions, bought, keywords } = req.body;
  const data = {};
  if (name !== undefined) data.name = name.trim();
  if (brand !== undefined) data.brand = brand?.trim() || null;
  if (model !== undefined) data.model = model?.trim() || null;
  if (category !== undefined) data.category = category?.trim() || null;
  if (url !== undefined) data.url = url?.trim() || null;
  if (notes !== undefined) data.notes = notes?.trim() || null;
  if (price !== undefined) data.price = price != null ? parseFloat(price) : null;
  if (currency !== undefined) data.currency = currency?.trim() || "SEK";
  if (dimensions !== undefined) data.dimensions = dimensions || null;
  if (bought !== undefined) data.bought = Boolean(bought);
  if (keywords !== undefined) data.keywords = Array.isArray(keywords) ? keywords.map((k) => k.trim()).filter(Boolean) : [];

  const id = parseInt(req.params.id, 10);
  try {
    // Ticking "bought" moves the item into the gear closet, but only on the
    // transition — so the previous value has to be read first. When `bought`
    // isn't part of the update there is nothing to compare and the write scopes
    // itself to the caller's rows instead.
    let wasBought = null;
    if (bought !== undefined) {
      const existing = await prisma.travelWishlistItem.findFirst({
        where: { id, user_id: req.user.id },
        select: { bought: true },
      });
      if (!existing) return res.status(404).json({ error: "Item not found" });
      wasBought = existing.bought;
    }

    const item = await prisma.travelWishlistItem.update({
      where: { id, user_id: req.user.id },
      data,
    });

    if (Boolean(bought) && wasBought === false) {
      await prisma.gearItem.create({
        data: {
          user_id: req.user.id,
          name: item.name,
          brand: item.brand || null,
          model: item.model || null,
          category: item.category || null,
          url: item.url || null,
          notes: item.notes || null,
          dimensions: item.dimensions || null,
          tags: item.keywords || [],
          worn: false,
        },
      });
    }

    res.json({ data: item });
  } catch (err) {
    fail(res, err, { context: `PATCH wishlist ${req.params.id}`, notFound: "Item not found" });
  }
});

// DELETE /travel/wishlist/:id
router.delete("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  try {
    await prisma.travelWishlistItem.delete({
      where: { id: parseInt(req.params.id, 10), user_id: req.user.id },
    });
    res.json({ message: "Item deleted" });
  } catch (err) {
    fail(res, err, { context: `DELETE wishlist ${req.params.id}`, notFound: "Item not found" });
  }
});

// GET /travel/wishlist/keywords — all unique keywords from non-bought items (for RSS watcher)
router.get("/keywords", async (req, res) => {
  try {
    const where = req.user.role === "SYSTEM"
      ? { bought: false }
      : { user_id: req.user.id, bought: false };
    const items = await prisma.travelWishlistItem.findMany({
      where,
      select: { keywords: true },
    });
    const unique = [...new Set(items.flatMap((i) => i.keywords))].sort();
    res.json({ data: unique });
  } catch (err) {
    fail(res, err, { context: "GET wishlist keywords" });
  }
});

module.exports = router;
