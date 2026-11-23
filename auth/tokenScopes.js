// What a scoped token may reach (THO-972).
//
// verifyJWT reads nothing from the database, and the tokens
// scripts/generate-service-token.js mints have no expiry. Before this, the
// token wander holds to read a packing list was a full session for its
// account: it could ask for an email change (which needed no password,
// THO-835) and then reset the password, locking the owner out for good. A
// token carrying `scope` is limited to the calls listed for that scope here,
// whatever its role says; a token without one is a full session as before,
// because python-crohn's SYSTEM token and every login token carry none.

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
 */
function serviceTokenClaims(user, { wander = false } = {}) {
  if (wander) {
    if (user.role !== 'USER') {
      throw new Error(`A wander token must be for a USER account; ${user.email} is ${user.role}`);
    }
    return { id: user.id, email: user.email, role: 'USER', scope: WANDER_TOKEN_SCOPE };
  }
  return { id: user.id, email: user.email, role: user.role };
}

module.exports = { WANDER_TOKEN_SCOPE, WANDER_SCOPE_ROUTES, tokenScopeVerdict, serviceTokenClaims };
