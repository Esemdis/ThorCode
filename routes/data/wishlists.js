/**
 * Everything under /data/concerts to do with wishlists.
 *
 * The routes live in ./wishlists/, split by what they are for, and are mounted
 * here in their original declaration order. Express matches in that order and
 * several of these patterns overlap — /wishlists/raw and /wishlists/:id most
 * obviously — so wishlists.test.js pins the surface rather than trusting it.
 */
const express = require("express");
const router = express.Router();

router.use(require("./wishlists/reads"));
router.use(require("./wishlists/bands"));
router.use(require("./wishlists/notify"));
router.use(require("./wishlists/calendar"));
router.use(require("./wishlists/attendance"));

module.exports = router;
