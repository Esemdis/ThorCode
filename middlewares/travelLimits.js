const { rateLimiter } = require("../utils/rateLimiter");

// Reads and writes get different ceilings because they cost different things.
// Opening the trip page fires a handful of GETs at once and re-fires them on
// every navigation, so reads need headroom; a write is rarer, and each one is a
// round of database work, so it gets a tighter bound. Both are per IP.
const readLimit = rateLimiter({
  windowMs: 60 * 1000,
  max: 300,
  message: "Too many requests — give it a moment.",
});

const writeLimit = rateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: "Too many changes at once — try again shortly.",
});

module.exports = function travelLimits(req, res, next) {
  return (req.method === "GET" ? readLimit : writeLimit)(req, res, next);
};
