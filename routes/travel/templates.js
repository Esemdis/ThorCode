const express = require("express");
const router = express.Router();
const { body, param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));

// GET /travel/templates — list user's templates
router.get("/", async (req, res) => {
  try {
    const templates = await prisma.template.findMany({
      where: { user_id: req.user.id },
      include: { _count: { select: { items: true } } },
      orderBy: { created_at: "desc" },
    });
    res.json({ data: templates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /travel/templates — create template
router.post(
  "/",
  [body("name").notEmpty().trim()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { name, description } = req.body;
    try {
      const template = await prisma.template.create({
        data: {
          user_id: req.user.id,
          name: name.trim(),
          description: description?.trim() || null,
        },
      });
      res.status(201).json({ data: template });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// GET /travel/templates/:id — get template with items
router.get("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  try {
    const template = await prisma.template.findFirst({
      where: { id: parseInt(req.params.id), user_id: req.user.id },
      include: { items: { orderBy: [{ sort_order: "asc" }, { created_at: "asc" }] } },
    });
    if (!template) return res.status(404).json({ error: "Template not found" });
    res.json({ data: template });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /travel/templates/:id
router.patch("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  const { name, description } = req.body;
  const data = {};
  if (name !== undefined) data.name = name.trim();
  if (description !== undefined) data.description = description?.trim() || null;

  try {
    const existing = await prisma.template.findFirst({
      where: { id: parseInt(req.params.id), user_id: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Template not found" });

    const template = await prisma.template.update({
      where: { id: parseInt(req.params.id) },
      data,
    });
    res.json({ data: template });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /travel/templates/:id
router.delete("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  try {
    const existing = await prisma.template.findFirst({
      where: { id: parseInt(req.params.id), user_id: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Template not found" });

    await prisma.template.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ message: "Template deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
