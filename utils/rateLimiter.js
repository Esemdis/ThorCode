const rateLimit = require("express-rate-limit");
// Rate limiter: max 5 requests per 15 minutes per IP

function rateLimiter({
  message = "Too many requests, please try again later.",
  windowMs = 15 * 60 * 1000, // 15 minutes
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
