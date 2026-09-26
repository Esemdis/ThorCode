/**
 * Putting a support act from the scraped lineup on a show's bill.
 *
 * Split out of routes/data/media.js, which had grown to 1715 lines and
 * fourteen endpoints. media.js mounts this and its siblings in their
 * original declaration order — the manifest test in media.test.js pins
 * the resulting surface.
 */
const express = require('express');
const { param, body, validationResult } = require('express-validator');

const auth = require('../../../auth/verifyJWT');
const roleCheck = require('../../../middlewares/roleCheck');
const prisma = require('../../../prisma/client');
const {
  fail, badRequest, notFound, forbidden, success,
} = require('../../../utils/apiResponse');
const { billForConcert } = require('../../../utils/concertBill');
const { canonicalBandName } = require('../../../utils/lineupNames');
const { ownAttendance } = require('./shared');

const router = express.Router();

/**
 * Put a support act on a concert's bill so photographs can be tagged to them.
 *
 * ConcertMedia.band_id is a foreign key, so an act that exists only as a
 * string in the scraped lineup has nothing to point at. This creates the row
 * it needs — and that is why it is a separate, deliberate call rather than
 * something the tagging routes do quietly on the way past.
 *
 * Band is ONE table shared by every account. A row created here exists for
 * everyone, and the ConcertBandReference puts the act on that night's bill for
 * everyone else who attended, feeding their bands-seen counts. Two guards
 * follow from that: admin only, and only a name the scraper actually recorded
 * for this concert — otherwise one account could put any band on any bill.
 */
router.post(
  '/attendances/:attendanceId/lineup',
  [
    auth, roleCheck(['ADMIN']),
    param('attendanceId').isInt(),
    body('name').isString().isLength({ min: 1, max: 200 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return badRequest(res, 'Validation failed');

      const attendanceId = parseInt(req.params.attendanceId, 10);
      const { row, owned } = await ownAttendance(attendanceId, req.user.id);
      if (!row) return notFound(res, 'Attendance not found');
      if (!owned) return forbidden(res, 'Forbidden');

      const key = canonicalBandName(req.body.name);
      if (!key) return badRequest(res, 'That is not a name');

      const bill = billForConcert({
        bands: row.concert_rel.bands.map((b) => ({ id: b.band_rel.id, name: b.band_rel.name })),
        metadata: row.concert_rel.metadata,
      });
      const entry = bill.find((b) => canonicalBandName(b.name) === key);
      if (!entry) return badRequest(res, "That name is not on this show's scraped lineup");

      // Already has a row and is already on this bill. Answered as success
      // rather than as a conflict: the caller asked for a state that holds.
      if (entry.linked) {
        return success(res, 201, { band: { id: entry.id, name: entry.name }, created: false });
      }

      // Matched canonically against every band, the same comparison
      // enrich-lineup uses. Band.name is unique, so a second "Svalbard" is not
      // untidy but unwritable — and "Svalbard (UK)" off the scraper would be
      // exactly that attempt.
      const all = await prisma.band.findMany({ select: { id: true, name: true } });
      let band = all.find((b) => canonicalBandName(b.name) === key);
      let created = false;
      if (!band) {
        // entry.name, not req.body.name: the bill has already had the
        // scraper's "Counterparts266K Followers" cleaned off it, and this row
        // is permanent and shared.
        try {
          band = await prisma.band.create({ data: { name: entry.name, created_at: new Date() } });
          created = true;
        } catch (err) {
          // Added by someone else since the read above. Theirs stands.
          if (err.code !== 'P2002') throw err;
          band = await prisma.band.findUnique({ where: { name: entry.name } });
          if (!band) throw err;
        }
      }

      // skipDuplicates rather than a read then a create: two presses of the
      // same pill both read "no link" and the second create was a 500.
      await prisma.concertBandReference.createMany({
        data: [{ concert: row.concert_rel.id, band: band.id }],
        skipDuplicates: true,
      });

      return success(res, 201, { band: { id: band.id, name: band.name }, created });
    } catch (err) {
      return fail(res, err, { context: 'POST /attendances/:attendanceId/lineup' });
    }
  },
);

module.exports = router;
