/**
 * Everything under /data/concerts to do with the photo and video archive.
 *
 * The routes live in ./media/, split by what they are for, and are mounted
 * here in their original declaration order, which Express matches in. The
 * manifest test in media.test.js pins the resulting surface, auth included,
 * so a reordering or a dropped middleware cannot pass quietly.
 */
const express = require('express');
const router = express.Router();

router.use(require('./media/upload'));
router.use(require('./media/reads'));
router.use(require('./media/lineup'));
router.use(require('./media/tagging'));
router.use(require('./media/deletes'));
router.use(require('./media/share'));
router.use(require('./media/bytes'));

module.exports = router;
