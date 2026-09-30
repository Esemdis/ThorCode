const { rateLimiter } = require('./rateLimiter');

/**
 * One budget for every route that spends the server's own setlist.fm key on a
 * caller's behalf: a band's setlist history, a setlist looked up by id, and a
 * show imported from one.
 *
 * The key is shared by every account and capped per day by setlist.fm, and
 * these routes had no limit at all, so one account — or one client stuck in a
 * loop — could spend it for everyone. One instance, imported by each route,
 * because express-rate-limit keeps its count inside the instance: a second
 * would be a second budget.
 *
 * Per account rather than per address, like the email limits: a household
 * shares one address and should not share one budget. Normal use sits far
 * below it — a likely setlist is fetched once per band per page load, and
 * only when it is opened.
 */
const setlistFmLimit = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many setlist.fm lookups. Please wait a few minutes and try again.',
  keyGenerator: (req) => req.user?.id ?? req.ip,
});

module.exports = { setlistFmLimit };
