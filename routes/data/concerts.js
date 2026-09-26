/**
 * Bands, wishlists and the calendar feed, all under /data/concerts.
 *
 * Formerly ticketmaster.js. Nothing in it is about Ticketmaster, and the name
 * sent anyone looking for the concert routes to the wrong file.
 */
const express = require("express");
const router = express.Router();

router.use(require("./bands"));
router.use(require("./wishlists"));
router.use(require("./calendar"));

module.exports = router;
