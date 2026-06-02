const express = require("express");
const router = express.Router({ mergeParams: true });
const { body, param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));

async function ownsTemplate(userId, templateId) {
  const template = await prisma.template.findFirst({ where: { id: templateId, user_id: userId } });
  return !!template;
}

// GET /travel/templates/:templateId/items
router.get("/", param("templateId").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid templateId" });

  const templateId = parseInt(req.params.templateId);
  if (!(await ownsTemplate(req.user.id, templateId))) return res.status(404).json({ error: "Template not found" });

  try {
    const items = await prisma.templateItem.findMany({
      where: { template_id: templateId },
      orderBy: [{ sort_order: "asc" }, { created_at: "asc" }],
    });
    res.json({ data: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /travel/templates/:templateId/items
router.post(
  "/",
  [param("templateId").isInt(), body("name").notEmpty().trim()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const templateId = parseInt(req.params.templateId);
    if (!(await ownsTemplate(req.user.id, templateId))) return res.status(404).json({ error: "Template not found" });

    const { name, category, note, url, sort_order } = req.body;
    try {
      const item = await prisma.templateItem.create({
        data: {
          template_id: templateId,
          name: name.trim(),
          category: category?.trim() || null,
          note: note?.trim() || null,
          url: url?.trim() || null,
          sort_order: sort_order ?? 0,
        },
      });
      res.status(201).json({ data: item });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// PATCH /travel/templates/:templateId/items/:itemId
router.patch(
  "/:itemId",
  [param("templateId").isInt(), param("itemId").isInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid parameters" });

    const templateId = parseInt(req.params.templateId);
    const itemId = parseInt(req.params.itemId);
    if (!(await ownsTemplate(req.user.id, templateId))) return res.status(404).json({ error: "Template not found" });

    const { name, category, note, url, sort_order } = req.body;
    const data = {};
    if (name !== undefined) data.name = name.trim();
    if (category !== undefined) data.category = category?.trim() || null;
    if (note !== undefined) data.note = note?.trim() || null;
    if (url !== undefined) data.url = url?.trim() || null;
    if (sort_order !== undefined) data.sort_order = sort_order;

    try {
      const existing = await prisma.templateItem.findFirst({ where: { id: itemId, template_id: templateId } });
      if (!existing) return res.status(404).json({ error: "Item not found" });

      const item = await prisma.templateItem.update({ where: { id: itemId }, data });
      res.json({ data: item });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// DELETE /travel/templates/:templateId/items/:itemId
router.delete(
  "/:itemId",
  [param("templateId").isInt(), param("itemId").isInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid parameters" });

    const templateId = parseInt(req.params.templateId);
    const itemId = parseInt(req.params.itemId);
    if (!(await ownsTemplate(req.user.id, templateId))) return res.status(404).json({ error: "Template not found" });

    try {
      const existing = await prisma.templateItem.findFirst({ where: { id: itemId, template_id: templateId } });
      if (!existing) return res.status(404).json({ error: "Item not found" });

      await prisma.templateItem.delete({ where: { id: itemId } });
      res.json({ message: "Item deleted" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
