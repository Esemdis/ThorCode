/**
 * Whether POST /users/register makes new accounts.
 *
 * Closed unless REGISTRATION_OPEN is exactly "true". The sign-up pages of
 * concert-map and travel-bag are on the public internet and the route asked
 * for nothing but an address nobody verified, so anyone who found either page
 * got an account: a wishlist of their own, and band adds that put work on the
 * scraper. The accounts here are a household's, added a few times ever, so the
 * default is the safe one and opening is the deliberate act: set the variable,
 * restart, have the person sign up, unset it.
 *
 * Read on every request rather than once at start-up, so a test can set it,
 * and so the answer is never a value captured before dotenv ran.
 *
 * Only the string "true" opens it. "1", "yes" or a typo leaving it open by
 * accident is the failure this exists to prevent.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function registrationOpen(env = process.env) {
  return env.REGISTRATION_OPEN === 'true';
}

// Said to the person on the sign-up page, so it is a sentence for them.
const REGISTRATION_CLOSED_MESSAGE = 'Sign-up is closed. Ask the owner for an account.';

/**
 * Refuses the request while registration is closed. First on the route, ahead
 * of the limiter and the validation: a closed door answers the same whatever
 * was sent, and says nothing about which addresses already have an account.
 */
function requireOpenRegistration(req, res, next) {
  if (registrationOpen()) return next();
  return res.status(403).json({ error: REGISTRATION_CLOSED_MESSAGE });
}

module.exports = { registrationOpen, requireOpenRegistration, REGISTRATION_CLOSED_MESSAGE };
