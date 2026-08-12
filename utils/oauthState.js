// The `state` parameter in an OAuth round trip has one job: prove that the
// callback belongs to a flow we started, and say whose it is.
//
// The obvious place to keep that is Redis, which is where this started and how
// routes/oauth/tmdb.js still does it. But Redis is optional infrastructure here
// — utils/cache.js logs "Cache disabled" and carries on when it cannot connect
// — and cacheData throws when it is down, so connecting an account failed with
// a 500 on a server that was otherwise completely healthy.
//
// So the state carries its own proof instead: a short-lived JWT signed with the
// same secret as the session tokens. Nothing to store and nothing to be down.
//
// The tradeoff is that a state cannot be marked as spent, so the same one
// verifies twice inside its window. That is acceptable here because it is not
// what state defends against — an attacker cannot mint one without the secret,
// and the authorization code it arrives with is single-use at the provider, so
// a replayed state carries nothing that can be exchanged.

const jwt = require('jsonwebtoken');

const DEFAULT_TTL_S = 600;

/**
 * Mint a state value for an OAuth flow.
 *
 * @param {{ user: string, purpose: string, ttlSeconds?: number }} params -
 *   `purpose` names the flow, e.g. 'spotify_oauth'. It is checked on the way
 *   back: without it a user's ordinary session token would verify here and
 *   could be handed in as state.
 * @returns {string}
 */
function signOAuthState({ user, purpose, ttlSeconds = DEFAULT_TTL_S }) {
  if (!user || !purpose) throw new Error('OAuth state needs a user and a purpose');
  return jwt.sign({ user, purpose }, process.env.JWT_SECRET, { expiresIn: ttlSeconds });
}

/**
 * Read a state value back, or null if it is missing, expired, tampered with, or
 * was minted for a different flow.
 *
 * @param {unknown} state
 * @param {string} purpose
 * @returns {{ user: string }|null}
 */
function verifyOAuthState(state, purpose) {
  if (typeof state !== 'string' || !state) return null;
  try {
    const decoded = jwt.verify(state, process.env.JWT_SECRET);
    if (decoded?.purpose !== purpose) return null;
    if (!decoded?.user) return null;
    return { user: decoded.user };
  } catch {
    return null;
  }
}

module.exports = { signOAuthState, verifyOAuthState, DEFAULT_TTL_S };
