const rateLimit = require('express-rate-limit');
// Rate limiter: max 5 requests per 15 minutes per IP

function rateLimiter({
  message = 'Too many requests, please try again later.',
  windowMs = 1 * 60 * 1000, // 1 minute
  max = 10, // limit each IP to 10 requests per windowMs
}) {
  return (registerLimiter = rateLimit({
    windowMs,
    max,
    message: { error: message },
  }));
}

module.exports = {
  rateLimiter,
};
