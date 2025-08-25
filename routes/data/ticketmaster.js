const express = require("express");
const router = express.Router();

// Delegate to split routers
router.use(require("./bands"));
router.use(require("./wishlists"));

module.exports = router;
