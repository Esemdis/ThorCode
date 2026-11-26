/**
 * Ending login sessions after a password reset or change (THO-898).
 *
 * A JWT is good until it expires, and verifyJWT used to check nothing but the
 * signature, so a session opened with a leaked password outlived the reset
 * that was meant to end it by up to eight hours. Now `User.password_changed_at`
 * records when the password last changed (a reset, a change, or an email
 * change), every login token carries the value it was signed against (`pwc`),
 * and a login token whose `pwc` is not the account's current one is refused.
 *
 * Tied to the password state, not to the clock. Comparing `iat` with the
 * change time let two kinds of session through: one an attacker with the old
 * password timed into the reset's own second (successful logins are not
 * rate-limited, so a script always has one), and one whose login read the old
 * row before the reset committed and signed after it. Both carry the old
 * `pwc`. `pwc` is read from the same row as the hash the login checked.
 *
 * Only login tokens. ThorCode also accepts long-lived JWTs minted outside the
 * login route: python-crohn's SYSTEM token from
 * scripts/generate-service-token.js, and the USER token each wander user
 * pastes into wander so it can read their travel-bag data. Some of those carry
 * a `service` claim, but wander's are minted by hand and nothing says they do,
 * so "no `service` claim" is not a safe test for "a session". The test is the
 * other way round: signJWT, which only the routes that check a password call,
 * marks its tokens `kind: 'login'`, and only a token so marked is ever looked
 * up or refused. Revoking anything else would silently cut those integrations
 * off for the person who just reset their password.
 *
 * A login token for an account that no longer exists is refused too (owner
 * decision on THO-898). The read is made anyway, so it costs nothing.
 *
 * The price of the mark: the login tokens already out when this deploys carry
 * none, so a reset in the first eight hours after it does not end them. They
 * expire on their own by then.
 */

const LOGIN_TOKEN_KIND = 'login';

/** Whether a verified payload is a session from the login route. */
function isLoginToken(decoded) {
  return decoded?.kind === LOGIN_TOKEN_KIND;
}

/** Cached for an account with no row: its login tokens are refused. */
const ACCOUNT_GONE = Symbol('account gone');

/**
 * The password state a login token is signed with and checked against: the
 * change time in milliseconds (the column holds milliseconds, so it reads
 * back exactly), 0 for a password that never changed.
 *
 * @param {Date|null|undefined} passwordChangedAt
 */
function passwordChangeStamp(passwordChangedAt) {
  return passwordChangedAt ? passwordChangedAt.getTime() : 0;
}

/**
 * Why a login token no longer opens a session, or null when it still does.
 *
 * @param {{ pwc?: number }} decoded - a verified login token
 * @param {Date|null|typeof ACCOUNT_GONE} state - what the cache holds for its user
 */
function loginStateRefusal(decoded, state) {
  if (state === ACCOUNT_GONE) return 'This account no longer exists.';
  // A login token without `pwc` was not minted by this API since THO-898,
  // so it gets no benefit of the doubt.
  if (decoded?.pwc !== passwordChangeStamp(state)) return 'Your password was changed. Sign in again.';
  return null;
}

// A minute: a reset reaches every session within it even if the forget below
// were missed, and an active session costs one indexed read a minute instead
// of one per request (concert-map fires a dozen on opening the map).
//
// The forget that makes a reset take effect at once is in-process, which
// holds because the API runs as one container. With a second one, a reset,
// change or deletion made through one would take up to this long to reach
// sessions served by the other.
const PASSWORD_CHANGE_CACHE_MS = 60 * 1000;
// Far above the number of people who use this. Only there so the map cannot
// grow without end; clearing it costs one read per active user.
const PASSWORD_CHANGE_CACHE_MAX = 10_000;

/**
 * A per-user cache of when the password last changed (a Date or null), or
 * ACCOUNT_GONE when there is no row, read through `read`.
 *
 * `forget` is called by every route that changes a password or deletes an
 * account, so the cache is never what lets an ended session through: the API
 * runs as one process, and the next request after a reset reads the row again.
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
      const value = row ? (row.password_changed_at ?? null) : ACCOUNT_GONE;
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
  return loginStateRefusal(decoded, await passwordChanges.get(decoded.id));
}

/**
 * Drop what the cache holds for this user. Call after changing their password
 * or deleting their account.
 */
function forgetPasswordChange(userId) {
  passwordChanges.forget(userId);
}

module.exports = {
  LOGIN_TOKEN_KIND,
  ACCOUNT_GONE,
  isLoginToken,
  passwordChangeStamp,
  loginStateRefusal,
  createPasswordChangeCache,
  loginTokenRefusal,
  forgetPasswordChange,
};
