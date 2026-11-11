/**
 * Ending login sessions after a password reset or change (THO-898).
 *
 * A JWT is good until it expires, and verifyJWT used to check nothing but the
 * signature, so a session opened with a leaked password outlived the reset
 * that was meant to end it by up to eight hours. Now `User.password_changed_at`
 * records when the password last changed, and a login token issued before
 * that is refused.
 *
 * Only login tokens. ThorCode also accepts long-lived JWTs minted outside the
 * login route: python-crohn's SYSTEM token from
 * scripts/generate-service-token.js, and the USER token each wander user
 * pastes into wander so it can read their travel-bag data. Some of those carry
 * a `service` claim, but wander's are minted by hand and nothing says they do,
 * so "no `service` claim" is not a safe test for "a session". The test is the
 * other way round: signJWT, which only the login route calls, marks its tokens
 * `kind: 'login'`, and only a token so marked is ever looked up or refused.
 * Revoking anything else would silently cut those integrations off for the
 * person who just reset their password.
 *
 * The price of that: the login tokens already out when this deploys carry no
 * mark, so a reset in the first eight hours after it does not end them. They
 * expire on their own by then.
 */

const LOGIN_TOKEN_KIND = 'login';

/** Whether a verified payload is a session from the login route. */
function isLoginToken(decoded) {
  return decoded?.kind === LOGIN_TOKEN_KIND;
}

/**
 * Whether a login token was issued before the password last changed.
 *
 * In whole seconds, because that is all `iat` holds. Comparing it against the
 * change time in milliseconds refused the token handed back by the change
 * itself: changed at 10.7 s, a token signed a moment later still says iat 10,
 * and 10 000 < 10 700. The cost is that a token issued in the same second as
 * the change survives it, which is a second, not a session.
 *
 * @param {number|undefined} iat - The token's issued-at, in epoch seconds.
 * @param {Date|null|undefined} passwordChangedAt
 */
function issuedBeforePasswordChange(iat, passwordChangedAt) {
  if (!passwordChangedAt) return false;
  // jsonwebtoken always sets iat; a login token without one is not something
  // this API minted, so it gets no benefit of the doubt.
  if (typeof iat !== 'number') return true;
  return iat < Math.floor(passwordChangedAt.getTime() / 1000);
}

// A minute: a reset reaches every session within it even if the forget below
// were missed, and an active session costs one indexed read a minute instead
// of one per request (concert-map fires a dozen on opening the map).
const PASSWORD_CHANGE_CACHE_MS = 60 * 1000;
// Far above the number of people who use this. Only there so the map cannot
// grow without end; clearing it costs one read per active user.
const PASSWORD_CHANGE_CACHE_MAX = 10_000;

/**
 * A per-user cache of when the password last changed (a Date or null), read
 * through `read`.
 *
 * `forget` is called by every route that changes a password, so the cache is
 * never what lets an ended session through: the API runs as one process, and
 * the next request after a reset reads the row again.
 *
 * @param {object} options
 * @param {(userId: string) => Promise<{ password_changed_at: Date|null }|null>} options.read
 * @param {() => number} [options.now]
 */
function createPasswordChangeCache({ read, now = Date.now, ttlMs = PASSWORD_CHANGE_CACHE_MS }) {
  const entries = new Map();
  // Bumped by every forget. A read that started before a reset and finished
  // after it would otherwise put the old answer back into the cache for a
  // minute, right after the reset cleared it.
  let generation = 0;

  return {
    async get(userId) {
      const hit = entries.get(userId);
      if (hit && now() - hit.at < ttlMs) return hit.value;

      const started = generation;
      const row = await read(userId);
      // No row is no change. A deleted account's sessions are left to expire
      // (owner decision on THO-810), and the integration tests sign tokens for
      // ids that were never created.
      const value = row?.password_changed_at ?? null;
      if (started === generation) {
        if (entries.size >= PASSWORD_CHANGE_CACHE_MAX) entries.clear();
        entries.set(userId, { value, at: now() });
      }
      return value;
    },
    forget(userId) {
      generation += 1;
      entries.delete(userId);
    },
  };
}

// Required on first use, not at load: every router requires verifyJWT, and the
// unit tests that load one without a fake Prisma client must not construct a
// real one just for a token check they never make.
const passwordChanges = createPasswordChangeCache({
  read: (userId) => require('../prisma/client').user.findUnique({
    where: { id: userId },
    select: { password_changed_at: true },
  }),
});

/**
 * Why this login token no longer opens a session, or null when it still does.
 * Not called for any other kind of token.
 */
async function loginTokenRefusal(decoded) {
  const passwordChangedAt = await passwordChanges.get(decoded.id);
  if (issuedBeforePasswordChange(decoded.iat, passwordChangedAt)) {
    return 'Your password was changed. Sign in again.';
  }
  return null;
}

/** Drop what the cache holds for this user. Call after changing their password. */
function forgetPasswordChange(userId) {
  passwordChanges.forget(userId);
}

module.exports = {
  LOGIN_TOKEN_KIND,
  isLoginToken,
  issuedBeforePasswordChange,
  createPasswordChangeCache,
  loginTokenRefusal,
  forgetPasswordChange,
};
