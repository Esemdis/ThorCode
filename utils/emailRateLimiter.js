const { rateLimiter } = require('./rateLimiter');

/**
 * Rate limiter for email operations
 * Email delivery and guesses are tied to an account, not a shared IP. A
 * household NAT must not let one user consume another user's verification
 * budget, and an attacker rotating IPs must not get extra guesses.
 */
const accountKey = (req) => req.user?.id ?? req.ip;

const emailRequestRateLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: 'Too many email requests. Please try again later.',
  keyGenerator: accountKey,
});

const emailVerificationRateLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: 'Too many verification attempts. Please try again later.',
  keyGenerator: accountKey,
});

module.exports = { emailRequestRateLimiter, emailVerificationRateLimiter };
