/**
 * What more than one of the wishlist routers needs.
 *
 * The limiter is here rather than built per module for a reason: express-rate-
 * limit keeps its counter inside the instance, so a second one would give those
 * routes a second budget and quietly double the limit a caller actually gets.
 * One instance, imported everywhere, keeps the ceiling where it was.
 */
const { rateLimiter } = require("../../../utils/rateLimiter");

// 10 requests a minute per IP — rateLimiter's defaults.
const rateLimit = rateLimiter({
  message: "Too many wishlist changes at once, please try again shortly.",
});

module.exports = { rateLimit };
