const rateLimit = require('express-rate-limit');

// Thin wrapper over express-rate-limit so callers only supply the numbers they
// care about and every limiter answers in the same { error } shape.
function rateLimiter({
  message = 'Too many requests, please try again later.',
  windowMs = 1 * 60 * 1000, // 1 minute
  max = 10,                 // requests per window, per IP
  keyGenerator,
  // Count only requests that failed. For a login that is the whole point: the
  // budget is for wrong guesses, and a household signing in is not guessing.
  skipSuccessfulRequests = false,
  // A route that must not admit it was limited (THO-808: "forgot password"
  // answers the same whether or not the address has an account) sends its own
  // answer instead of the 429, and turns the budget headers off, which would
  // otherwise say the same thing.
  handler,
  standardHeaders = true,
  // Requests this returns true for are neither counted nor limited.
  skip,
} = {}) {
  return rateLimit({
    windowMs,
    max,
    message: { error: message },
    // Tell the caller its budget and when the window rolls over, so a client
    // can back off deliberately instead of discovering the ceiling by hitting
    // it. Additive: the legacy X-RateLimit-* headers still go out too.
    standardHeaders,
    // Only the draft headers are switchable by `standardHeaders`; the legacy
    // X-RateLimit-* ones follow it here so turning them off means off.
    ...(standardHeaders === false && { legacyHeaders: false }),
    skipSuccessfulRequests,
    ...(keyGenerator && { keyGenerator }),
    ...(handler && { handler }),
    ...(skip && { skip }),
  });
}

module.exports = {
  rateLimiter,
};
