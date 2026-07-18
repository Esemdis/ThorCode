const express = require("express");
const router = express.Router();

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));

// GET /travel/reviews — every review the user has written, newest first
router.get("/", async (req, res) => {
  try {
    const reviews = await prisma.itemReview.findMany({
      where: { user_id: req.user.id },
      include: {
        trip_rel: { select: { id: true, name: true, destination: true, start_date: true, end_date: true } },
        gear_item_rel: {
          select: {
            id: true, name: true, brand: true, model: true, category: true, dimensions: true,
            review_status: true, review_streak: true, review_count: true, essential: true,
            retired: true, photo: true,
            replaced_by_rel: { select: { id: true, name: true, brand: true } },
          },
        },
      },
      orderBy: [{ trip_rel: { start_date: "desc" } }, { created_at: "desc" }],
    });
    res.json({ data: reviews });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
