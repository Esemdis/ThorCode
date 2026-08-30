/**
 * Everything under /data/concerts to do with bands and their concerts.
 *
 * The routes themselves live in ./bands/, split by what they are for. They are
 * mounted here in their original declaration order, which Express matches in:
 * bands.test.js pins the resulting surface so a reordering cannot pass quietly.
 */
const express = require('express');
const router = express.Router();

router.use(require('./bands/ingest'));
router.use(require('./bands/search'));
router.use(require('./bands/writes'));
router.use(require('./bands/detail'));
router.use(require('./bands/admin'));
router.use(require('./bands/setlists'));

module.exports = router;
