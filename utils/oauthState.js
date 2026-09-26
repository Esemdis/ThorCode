// The `state` parameter in an OAuth round trip has one job: prove that the
// callback belongs to a flow we started, and say whose it is.
//
// The obvious place to keep that is Redis, which is where this started. But
// Redis is optional infrastructure here — utils/cache.js logs "Cache disabled"
// and carries on when it cannot connect — and cacheData throws when it is down,
// so connecting an account failed with a 500 on a server that was otherwise
// completely healthy.
//
// So the state carries its own proof instead: a short-lived JWT. Nothing to
// store and nothing to be down.
//
// It is NOT signed with JWT_SECRET itself. It used to be, and that made every
// state a login: verifyJWT accepted it as a bearer token, the state has no `id`,
// and Prisma reads `where: { user_id: undefined }` as no filter at all — so any
// signed-in user could lift the state out of /oauth/spotify/authorize-url and
// read, change or delete every other account's rows. A key derived for this
// purpose alone, plus an audience, means the two kinds of token cannot verify as
// each other in either direction.
//
// The tradeoff is that a state cannot be marked as spent, so the same one
// verifies twice inside its window. That is acceptable here because it is not
// what state defends against — an attacker cannot mint one without the secret,
// and the authorization code it arrives with is single-use at the provider, so
// a replayed state carries nothing that can be exchanged.

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const DEFAULT_TTL_S = 600;
const AUDIENCE = 'oauth-state';

// Derived rather than configured, so no deployment needs a new secret and the
// state key rotates whenever JWT_SECRET does.
function stateKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return crypto.createHmac('sha256', secret).update('thorcode:oauth-state:v1').digest();
}

/**
 * Mint a state value for an OAuth flow.
 *
 * @param {{ user: string, purpose: string, ttlSeconds?: number, [claim: string]: unknown }} params -
 *   `purpose` names the flow, e.g. 'spotify_oauth'. It is checked on the way
 *   back, so a state minted for one provider cannot complete another's flow.
 * @returns {string}
 */
function signOAuthState({ user, purpose, ttlSeconds = DEFAULT_TTL_S, ...claims }) {
  if (!user || !purpose) throw new Error('OAuth state needs a user and a purpose');
  // A provider-specific claim can bind the state to one request token. Put the
  // identity claims last so callers can never overwrite the flow's purpose.
  return jwt.sign({ ...claims, user, purpose }, stateKey(), {
    expiresIn: ttlSeconds,
    audience: AUDIENCE,
    algorithm: 'HS256',
  });
}

/**
 * Read a state value back, or null if it is missing, expired, tampered with, or
 * was minted for a different flow.
 *
 * @param {unknown} state
 * @param {string} purpose
 * @returns {{ user: string, [claim: string]: unknown }|null}
 */
function verifyOAuthState(state, purpose) {
  if (typeof state !== 'string' || !state) return null;
  try {
    const decoded = jwt.verify(state, stateKey(), { audience: AUDIENCE, algorithms: ['HS256'] });
    if (decoded?.purpose !== purpose) return null;
    if (!decoded?.user) return null;
    // Do not return JWT bookkeeping claims to route code. Everything else was
    // explicitly put into the signed state by the initiating OAuth route.
    const {
      user, purpose: _purpose, iat: _iat, exp: _exp, nbf: _nbf, aud: _aud, ...claims
    } = decoded;
    return { user, ...claims };
  } catch {
    return null;
  }
}

module.exports = { signOAuthState, verifyOAuthState, DEFAULT_TTL_S };
