/**
 * Folding a duplicate band into the one that stays (THO-999).
 *
 * Its own module, mounted last in bands.js, so the routes before it keep the
 * order the manifest in bands.test.js pins. The work is in utils/bandMerge.js.
 */
const express = require('express');
const router = express.Router();
const auth = require('../../../auth/verifyJWT');
const roleCheck = require('../../../middlewares/roleCheck');
const prisma = require('../../../prisma/client');
const { withDetach } = require('../../../utils/mediaDetach');
const { mergeBands } = require('../../../utils/bandMerge');
const { retagBandInSidecars } = require('../../../utils/mediaUntag');

router.post('/bands/:bandId/merge-into/:targetId', auth, roleCheck(['ADMIN']), async (req, res) => {
  const sourceId = Number(req.params.bandId);
  const targetId = Number(req.params.targetId);
  if (!Number.isInteger(sourceId) || !Number.isInteger(targetId) || sourceId <= 0 || targetId <= 0) {
    return res.status(400).json({ error: 'Invalid band id' });
  }
  if (sourceId === targetId) return res.status(400).json({ error: 'A band cannot be merged into itself' });
  // Only `1` forces. Anything looser would let a stray `?force=0` or
  // `?force=false` override the conflict check it was meant to keep.
  const force = req.query.force === '1';

  try {
    // withDetach, not a bare $transaction, as DELETE /bands/:bandId does; and
    // 30s rather than the 5s default, because a band with years of shows,
    // follows and photographs moves thousands of rows one table at a time.
    const result = await withDetach(prisma, (tx) => mergeBands(tx, sourceId, targetId, { force }), { timeout: 30000 });

    if (result.status === 'missing') return res.status(404).json({ error: 'Band not found', bandId: result.bandId });
    if (result.status === 'conflict') {
      // 409 with the ids, so the admin can see why and choose "Merge anyway",
      // which resends with ?force=1. Two different MBIDs usually mean two
      // different artists; Spotify listing one artist twice is the exception.
      return res.status(409).json({ error: 'The bands carry different external ids', conflicts: result.conflicts });
    }

    // The sidecars after the rows have committed, best effort, the way the
    // delete untags them. The rebuild reads band_id from the sidecar, and the
    // source's id no longer exists, so a folder left behind is refused by the
    // foreign key on the next rebuild, which reports it.
    const { retagPaths, status: _merged, ...response } = result;
    const retagFailed = await retagBandInSidecars(retagPaths, sourceId, result.survivor);
    return res.json({ status: 'success', ...response, retaggedFiles: retagPaths.length, retagFailed: retagFailed.length });
  } catch (error) {
    console.error(`Error merging band ${sourceId} into ${targetId}:`, error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
