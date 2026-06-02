const express = require("express");
const router = express.Router();
const { body, param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));

// GET /travel/wishlist
router.get("/", async (req, res) => {
  try {
    const items = await prisma.travelWishlistItem.findMany({
      where: { user_id: req.user.id },
      orderBy: [{ bought: "asc" }, { category: "asc" }, { name: "asc" }],
    });
    res.json({ data: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /travel/wishlist
router.post("/", [body("name").notEmpty().trim()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const { name, brand, model, category, url, notes, price, currency } = req.body;
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
        currency: currency?.trim() || "EUR",
      },
    });
    res.status(201).json({ data: item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /travel/wishlist/:id
router.patch("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  const { name, brand, model, category, url, notes, price, currency, bought } = req.body;
  const data = {};
  if (name !== undefined) data.name = name.trim();
  if (brand !== undefined) data.brand = brand?.trim() || null;
  if (model !== undefined) data.model = model?.trim() || null;
  if (category !== undefined) data.category = category?.trim() || null;
  if (url !== undefined) data.url = url?.trim() || null;
  if (notes !== undefined) data.notes = notes?.trim() || null;
  if (price !== undefined) data.price = price != null ? parseFloat(price) : null;
  if (currency !== undefined) data.currency = currency?.trim() || "EUR";
  if (bought !== undefined) data.bought = Boolean(bought);

  try {
    const existing = await prisma.travelWishlistItem.findFirst({
      where: { id: parseInt(req.params.id), user_id: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Item not found" });

    const item = await prisma.travelWishlistItem.update({ where: { id: parseInt(req.params.id) }, data });
    res.json({ data: item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /travel/wishlist/:id
router.delete("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  try {
    const existing = await prisma.travelWishlistItem.findFirst({
      where: { id: parseInt(req.params.id), user_id: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Item not found" });

    await prisma.travelWishlistItem.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ message: "Item deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
