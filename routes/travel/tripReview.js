const express = require("express");
const router = express.Router({ mergeParams: true });
const { body, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const ownsTrip = require("../../middlewares/ownsTrip");
const prisma = require("../../prisma/client");
const { fail } = require("../../utils/apiResponse");
const { NOTE_MAX_LENGTH, text } = require("../../utils/travel/fields");
const { photoDataUrl, TRIP_PHOTO_MAX_LENGTH } = require("../../utils/travel/photo");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));
router.use(ownsTrip);

// GET /travel/trips/:tripId/trip-review — the trip-level review, if any
router.get("/", async (req, res) => {
  try {
    const review = await prisma.tripReview.findUnique({ where: { trip_id: req.tripId } });
    res.json({ data: review });
  } catch (err) {
    fail(res, err, { context: `GET trip-review (trip ${req.tripId})` });
  }
});

// The slot count is checked here; each photo's shape and size in the handler,
// through the same check gear photos use (utils/travel/photo.js). Any string
// used to be kept, and a non-string silently dropped (THO-981).
const MAX_CATEGORY_PHOTOS = 3;
const PHOTO_FIELDS = ["culture_photos", "food_photos", "fun_photos"];
const NOTE_FIELDS = ["culture_note", "food_note", "fun_note", "missing_note", "comment"];
// The gear list answers at most 500 rows, so more ids than this name gear
// that the wizard could not have offered.
const MAX_MISSING_GEAR_IDS = 1000;
const photosField = (name) =>
  body(name)
    .optional()
    .isArray({ max: MAX_CATEGORY_PHOTOS })
    .withMessage(`${name} takes at most ${MAX_CATEGORY_PHOTOS} photos`);

// POST /travel/trips/:tripId/trip-review — create/update the trip-level review.
// Body: { culture_rating?, culture_note?, culture_photos?, food_rating?, food_note?,
//         food_photos?, fun_rating?, fun_note?, fun_photos?, missing_gear_item_ids?,
//         missing_note?, comment? }
router.post(
  "/",
  [
    body("culture_rating").optional({ nullable: true }).isInt({ min: 1, max: 5 }),
    body("food_rating").optional({ nullable: true }).isInt({ min: 1, max: 5 }),
    body("fun_rating").optional({ nullable: true }).isInt({ min: 1, max: 5 }),
    photosField("culture_photos"),
    photosField("food_photos"),
    photosField("fun_photos"),
    body("missing_gear_item_ids")
      .optional()
      .isArray({ max: MAX_MISSING_GEAR_IDS })
      .withMessage(`missing_gear_item_ids takes at most ${MAX_MISSING_GEAR_IDS} ids`),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { culture_rating, food_rating, fun_rating, missing_gear_item_ids } = req.body;

    const photos = {};
    for (const field of PHOTO_FIELDS) {
      const list = req.body[field] ?? [];
      const checked = list.map((p) => photoDataUrl(p, TRIP_PHOTO_MAX_LENGTH));
      // A blank slot is not a photo either: the wizard never sends one.
      if (checked.some((p) => typeof p !== "string")) {
        return res.status(400).json({
          error: `${field} must hold JPEG, PNG or WebP image data URLs of at most ${TRIP_PHOTO_MAX_LENGTH.toLocaleString("en")} characters`,
        });
      }
      photos[field] = checked;
    }

    const notes = {};
    for (const field of NOTE_FIELDS) {
      const note = text(req.body[field], NOTE_MAX_LENGTH);
      if (note === undefined) {
        return res.status(400).json({ error: `${field} must be text of at most ${NOTE_MAX_LENGTH} characters` });
      }
      notes[field] = note;
    }

    const data = {
      culture_rating: culture_rating != null ? parseInt(culture_rating) : null,
      culture_note: notes.culture_note,
      culture_photos: photos.culture_photos,
      food_rating: food_rating != null ? parseInt(food_rating) : null,
      food_note: notes.food_note,
      food_photos: photos.food_photos,
      fun_rating: fun_rating != null ? parseInt(fun_rating) : null,
      fun_note: notes.fun_note,
      fun_photos: photos.fun_photos,
      missing_gear_item_ids: Array.isArray(missing_gear_item_ids)
        ? missing_gear_item_ids.map((id) => parseInt(id)).filter((id) => !Number.isNaN(id))
        : [],
      missing_note: notes.missing_note,
      comment: notes.comment,
    };

    try {
      const review = await prisma.tripReview.upsert({
        where: { trip_id: req.tripId },
        create: { user_id: req.user.id, trip_id: req.tripId, ...data },
        update: data,
      });
      res.status(201).json({ data: review });
    } catch (err) {
      fail(res, err, { context: `POST trip-review (trip ${req.tripId})` });
    }
  }
);

module.exports = router;
