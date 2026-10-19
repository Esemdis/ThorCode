/**
 * Your own private review of a venue (THO-192): sound, view, stage and vibe as
 * 1-5, wheelchair access as yes / partial / no, and one comment.
 *
 * Private by decision: only the author reads a review, so there is no
 * aggregate and no list, and every route is scoped to req.user. Only someone
 * with an attendance at a show that has already happened at the venue may
 * write one.
 */
const express = require("express");
const router = express.Router();
const { body, param, validationResult } = require("express-validator");
const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");
const { fail, forbidden } = require("../../utils/apiResponse");

const ASPECTS = ["sound", "view", "stage", "vibe"];
const COMMENT_MAX = 1000;
const guard = [auth, roleCheck(["ADMIN", "USER"]), param("venueId").isInt({ min: 1 }).withMessage("venueId must be an integer")];

const invalid = (req, res) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ error: errors.array()[0].msg });
  return true;
};

// GET /venues/:venueId/review — your review of the venue, or { data: null }
router.get("/venues/:venueId/review", guard, async (req, res) => {
  if (invalid(req, res)) return;
  try {
    const data = await prisma.venueReview.findUnique({
      where: { user_id_venue_id: { user_id: req.user.id, venue_id: parseInt(req.params.venueId, 10) } },
    });
    res.json({ data });
  } catch (err) {
    fail(res, err, { context: `GET venue review (venue ${req.params.venueId})` });
  }
});

// PUT /venues/:venueId/review — create or replace your review. A field left out
// is cleared, so the body is the whole review. Body: { sound?, view?, stage?,
// vibe?, wheelchair?, comment? }
router.put(
  "/venues/:venueId/review",
  [
    ...guard,
    ...ASPECTS.map((a) => body(a).optional({ values: "null" }).isInt({ min: 1, max: 5 }).withMessage(`${a} must be 1 to 5`)),
    body("wheelchair").optional({ values: "null" }).isIn(["YES", "PARTIAL", "NO"]).withMessage("wheelchair must be YES, PARTIAL or NO"),
    body("comment").optional({ values: "null" }).isString().isLength({ max: COMMENT_MAX }).withMessage(`comment takes at most ${COMMENT_MAX} characters`),
  ],
  async (req, res) => {
    if (invalid(req, res)) return;
    const venueId = parseInt(req.params.venueId, 10);
    const data = {
      ...Object.fromEntries(ASPECTS.map((a) => [a, req.body[a] == null ? null : parseInt(req.body[a], 10)])),
      wheelchair: req.body.wheelchair ?? null,
      comment: req.body.comment?.trim() || null,
    };
    if (Object.values(data).every((v) => v == null)) {
      return res.status(400).json({ error: "Rate something or leave a comment; delete the review to clear it." });
    }
    try {
      // "Attended" is an attendance row on a show that has happened: a show
      // still to come is the same row, marked Going.
      const been = await prisma.concertAttendance.findFirst({
        where: {
          wishlist_rel: { user_id: req.user.id },
          concert_rel: { venue_id: venueId, concert_date: { lt: new Date() } },
        },
        select: { id: true },
      });
      if (!been) return forbidden(res, "You can review a venue once you have been to a show there.");
      const review = await prisma.venueReview.upsert({
        where: { user_id_venue_id: { user_id: req.user.id, venue_id: venueId } },
        create: { user_id: req.user.id, venue_id: venueId, ...data },
        update: data,
      });
      res.json({ data: review });
    } catch (err) {
      fail(res, err, { context: `PUT venue review (venue ${venueId})` });
    }
  },
);

// DELETE /venues/:venueId/review — remove your review (a no-op when there is none)
router.delete("/venues/:venueId/review", guard, async (req, res) => {
  if (invalid(req, res)) return;
  try {
    await prisma.venueReview.deleteMany({ where: { user_id: req.user.id, venue_id: parseInt(req.params.venueId, 10) } });
    res.status(204).end();
  } catch (err) {
    fail(res, err, { context: `DELETE venue review (venue ${req.params.venueId})` });
  }
});

module.exports = router;
