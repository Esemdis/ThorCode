const rateLimit = require('express-rate-limit');

// Thin wrapper over express-rate-limit so callers only supply the numbers they
// care about and every limiter answers in the same { error } shape.
function rateLimiter({
  message = 'Too many requests, please try again later.',
  windowMs = 1 * 60 * 1000, // 1 minute
  max = 10,                 // requests per window, per IP
} = {}) {
  return rateLimit({
    windowMs,
    max,
    message: { error: message },
    // Tell the caller its budget and when the window rolls over, so a client
    // can back off deliberately instead of discovering the ceiling by hitting
    // it. Additive: the legacy X-RateLimit-* headers still go out too.
    standardHeaders: true,
  });
}

module.exports = {
  rateLimiter,
};
