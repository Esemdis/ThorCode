const { rateLimiter } = require('./rateLimiter');

/**
 * Rate limiter for email operations
 * 3 requests per 15 minutes per IP to prevent spam
 */
const emailRateLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: 'Too many email requests. Please try again later.',
});

module.exports = { emailRateLimiter };
