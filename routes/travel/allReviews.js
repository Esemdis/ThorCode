const express = require("express");
const router = express.Router();

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");
const { fail, paginate, sendList } = require("../../utils/apiResponse");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));

// GET /travel/reviews — every review the user has written, newest first
router.get("/", async (req, res) => {
  const { take, skip } = paginate(req, { defaultLimit: 150, maxLimit: 500 });
  try {
    const where = { user_id: req.user.id };
    const [reviews, total] = await Promise.all([
      prisma.itemReview.findMany({
        where,
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
        take,
        skip,
      }),
      prisma.itemReview.count({ where }),
    ]);
    sendList(res, reviews, { total, take, skip });
  } catch (err) {
    fail(res, err, { context: "GET reviews" });
  }
});

module.exports = router;
