// What a scoped token may reach (THO-972), and the claims a minted one carries.
//
// verifyJWT reads nothing from the database for a login token, and minted
// tokens used to have no expiry (they have since THO-1016: an expiry, and an
// id that can be withdrawn, auth/serviceTokens.js). Before this, the
// token wander holds to read a packing list was a full session for its
// account: it could ask for an email change (which needed no password,
// THO-835) and then reset the password, locking the owner out for good. A
// token carrying `scope` is limited to the calls listed for that scope here,
// whatever its role says; a token without one is a full session as before,
// because python-crohn's SYSTEM token and every login token carry none.

const { normaliseEmail } = require('../utils/validation/email');
const { SERVICE_TOKEN_DEFAULT_DAYS } = require('./serviceTokens');

const WANDER_TOKEN_SCOPE = 'wander';

// wander's four calls in server/services/thorcode.js, and nothing else. Not the
// "only /travel/trips/:id/*" the ticket first asked for: that would break the
// trip picker (GET /travel/trips), starting a travel-bag trip from wander
// (POST /travel/trips, THO-655) and the concerts card (THO-667). `\d+` rather
// than `[^/]+` keeps out /travel/trips/weather-pending and anything a later
// route adds under a word. A new wander call has to be added here, and ThorCode
// deployed, before wander ships it.
const WANDER_SCOPE_ROUTES = [
  { method: 'GET', re: /^\/travel\/trips\/?$/i },
  { method: 'POST', re: /^\/travel\/trips\/?$/i },
  { method: 'GET', re: /^\/travel\/trips\/\d+\/?$/i },
  { method: 'GET', re: /^\/travel\/trips\/\d+\/(items|todos)\/?$/i },
  { method: 'GET', re: /^\/data\/concerts\/nearby\/?$/i },
];

const SCOPE_ROUTES = { [WANDER_TOKEN_SCOPE]: WANDER_SCOPE_ROUTES };

/**
 * Whether a token may make this request: 'allow', 'forbidden' (a scope that
 * does not cover it) or 'unknown' (a scope this server does not know).
 *
 * Matched against `originalUrl`, the path as the client sent it, because
 * `req.path` is relative to whichever router the middleware runs in. It is
 * matched whole and strictly, so an odd spelling (`//travel`, `%2F`, `..`) is
 * refused rather than guessed at; Express routes those nowhere useful anyway.
 * Case and one trailing slash are let through because Express sends them to
 * the same handler. An unknown scope fails closed: a token minted by a newer
 * script must not read as a full session on an older server.
 */
function tokenScopeVerdict(decoded, method, originalUrl) {
  if (decoded?.scope === undefined) return 'allow';
  // A string, and an own key: ['wander'] would otherwise coerce to 'wander',
  // and 'constructor' would find Object's.
  const routes = typeof decoded.scope === 'string' && Object.hasOwn(SCOPE_ROUTES, decoded.scope)
    ? SCOPE_ROUTES[decoded.scope] : null;
  if (!routes) return 'unknown';
  const path = String(originalUrl ?? '').split('?')[0];
  const verb = String(method ?? '').toUpperCase();
  return routes.some((r) => r.method === verb && r.re.test(path)) ? 'allow' : 'forbidden';
}

/**
 * The claims scripts/generate-service-token.js signs for an account.
 *
 * A wander token is for a person's own account: an ADMIN or SYSTEM role in it
 * would outlive a demotion, since the role is read from the token and never
 * again from the database, so the script refuses those rather than mint one.
 *
 * Every minted token carries its ServiceToken row's id as `jti` and the row's
 * expiry as `exp` (THO-1016); verifyJWT refuses one with neither, so this
 * throws rather than sign a token that would never work.
 *
 * @param {{ id: string, email: string, role: string }} user
 * @param {{ wander?: boolean, jti: string, expiresAt: Date }} options
 */
function serviceTokenClaims(user, { wander = false, jti, expiresAt } = {}) {
  if (typeof jti !== 'string' || !jti) throw new Error('A minted token needs the id of its ServiceToken row');
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    throw new Error('A minted token needs an expiry');
  }
  // `exp` is whole seconds; jsonwebtoken would refuse to sign with both an
  // `exp` claim and an `expiresIn` option, so the claim is the one place.
  const lifetime = { jti, exp: Math.floor(expiresAt.getTime() / 1000) };
  if (wander) {
    if (user.role !== 'USER') {
      throw new Error(`A wander token must be for a USER account; ${user.email} is ${user.role}`);
    }
    return { id: user.id, email: user.email, role: 'USER', scope: WANDER_TOKEN_SCOPE, ...lifetime };
  }
  return { id: user.id, email: user.email, role: user.role, ...lifetime };
}

// Ten years. Long enough for any machine that should hold a token; a longer
// one is the never-expiring token this ticket ended, by another name, and a
// big enough number is not a date at all.
const SERVICE_TOKEN_MAX_DAYS = 3650;

/**
 * Reads generate-service-token.js's arguments: `[--wander] [--days N] <email>`.
 * Returns `{ wander, days, email }`, or `{ error }` with what was wrong.
 * `--days` must be a whole number of days from 1 to SERVICE_TOKEN_MAX_DAYS:
 * `1.5` is refused rather than rounded, because a token that ends at a time
 * nobody asked for is a surprise found only when a sync starts failing.
 *
 * @param {string[]} argv - process.argv.slice(2)
 */
function parseMintArgs(argv) {
  let wander = false;
  let days = SERVICE_TOKEN_DEFAULT_DAYS;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--wander') {
      wander = true;
    } else if (arg === '--days' || arg.startsWith('--days=')) {
      const value = arg === '--days' ? argv[(i += 1)] : arg.slice('--days='.length);
      if (!/^[1-9]\d*$/.test(value ?? '') || Number(value) > SERVICE_TOKEN_MAX_DAYS) {
        return { error: `--days must be a whole number from 1 to ${SERVICE_TOKEN_MAX_DAYS}, not ${value ?? 'nothing'}` };
      }
      days = Number(value);
    } else if (arg.startsWith('--')) {
      return { error: `Unknown option ${arg}` };
    } else {
      rest.push(arg);
    }
  }
  // Stored lowercased; see utils/validation/email.js.
  const email = rest.length === 1 ? normaliseEmail(rest[0]) : '';
  if (!email) return { error: 'Give exactly one email' };
  return { wander, days, email };
}

/** When a token minted at `now` for `days` days expires. */
function serviceTokenExpiry(days, now = new Date()) {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

module.exports = {
  WANDER_TOKEN_SCOPE,
  WANDER_SCOPE_ROUTES,
  SERVICE_TOKEN_MAX_DAYS,
  tokenScopeVerdict,
  serviceTokenClaims,
  parseMintArgs,
  serviceTokenExpiry,
};
