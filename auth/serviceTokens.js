/**
 * Withdrawing one minted token (THO-1016).
 *
 * scripts/generate-service-token.js mints the long-lived tokens python-crohn
 * (BACKEND_TOKEN) and wander (each user's pasted token) hold. They used to
 * carry no expiry and no id, and verifyJWT read nothing from the database, so
 * the only way to end one leaked token was to change JWT_SECRET, which ends
 * every session and every other minted token with it.
 *
 * Now each minted token has a `ServiceToken` row, written before the token is
 * signed, whose id is the token's `jti`, and an `exp` equal to the row's
 * `expires_at`. A token with a `jti` opens a session only while its row
 * exists, belongs to the same account, is not withdrawn and has not expired.
 * scripts/service-tokens.js lists and withdraws them.
 *
 * Three kinds of token reach verifyJWT, told apart by these two claims:
 *  - `jti`: a minted token. Looked up.
 *  - `exp` and no `jti`: a login token from signJWT (8 hours). No ServiceToken
 *    row; its password state is checked instead (auth/loginRevocation.js).
 *  - neither: a token minted before this change. Refused (owner decision on
 *    THO-1016, 1B): accepting them would leave exactly the tokens this ticket
 *    is about, the ones that cannot be withdrawn, working for good. Everyone
 *    holding one re-mints after deploy.
 */

const SERVICE_TOKEN_DEFAULT_DAYS = 365;

// Prisma generates `uuid()` ids in this shape. Checked before any query so a
// token signed with a `jti` of some other type or shape (an object would be
// read by Prisma as a filter) never reaches `where`.
const SERVICE_TOKEN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a value could be a ServiceToken id, before asking the database. */
function isServiceTokenId(value) {
  return typeof value === 'string' && SERVICE_TOKEN_ID_RE.test(value);
}

/**
 * What verifyJWT does with a verified token's lifetime: 'refuse' (no `jti` and
 * no `exp`, or a `jti` that cannot be a row's id), 'lookup' (a minted token,
 * checked against its row) or 'ok' (a login token, which `exp` already bounds).
 */
function tokenLifetimeVerdict(decoded) {
  if (decoded?.jti !== undefined) return isServiceTokenId(decoded.jti) ? 'lookup' : 'refuse';
  if (decoded?.exp !== undefined) return 'ok';
  return 'refuse';
}

/**
 * Why a minted token no longer opens a session, or null when it still does.
 * The reason is for logs and tests only: every refusal answers the same 401,
 * so a caller cannot probe which tokens exist.
 *
 * @param {{ id: string }} decoded - a verified token with a `jti`
 * @param {{ user_id: string, withdrawn_at: Date|null, expires_at: Date }|null} row
 * @param {number} now - milliseconds
 */
function serviceTokenRefusal(decoded, row, now) {
  if (!row) return 'no such token';
  // The row is the authority on whose token this is: a token whose signed id
  // disagrees with it was not minted by the script.
  if (row.user_id !== decoded.id) return 'token belongs to another account';
  if (row.withdrawn_at) return 'withdrawn';
  if (!(row.expires_at instanceof Date) || row.expires_at.getTime() <= now) return 'expired';
  return null;
}

// A minute. A withdrawal is made by scripts/service-tokens.js, in another
// process, so nothing can clear this cache when it happens: the minute is how
// long a withdrawn token may still be used. In return, python-crohn's sync,
// which makes hundreds of calls a run, costs one indexed read a minute instead
// of one per call. The API runs as one container; with a second one this still
// holds, each keeping its own minute.
const SERVICE_TOKEN_CACHE_MS = 60 * 1000;
// Far above the number of minted tokens. Only there so the map cannot grow
// without end (tokens with made-up but well-formed ids are cached as missing);
// clearing it costs one read per token in use.
const SERVICE_TOKEN_CACHE_MAX = 10_000;

/**
 * A per-`jti` cache of the ServiceToken row (or null for no row), read through
 * `read`. A missing row is cached like any other answer; a read that fails is
 * not, so the next request asks again.
 *
 * @param {object} options
 * @param {(jti: string) => Promise<object|null>} options.read
 * @param {() => number} [options.now]
 */
function createServiceTokenCache({ read, now = () => Date.now(), ttlMs = SERVICE_TOKEN_CACHE_MS }) {
  const entries = new Map();
  return {
    async get(jti) {
      const hit = entries.get(jti);
      if (hit && now() - hit.at < ttlMs) return hit.row;
      const row = (await read(jti)) ?? null;
      if (entries.size >= SERVICE_TOKEN_CACHE_MAX) entries.clear();
      entries.set(jti, { row, at: now() });
      return row;
    },
  };
}

// Required on first use, not at load: every router requires verifyJWT, and the
// unit tests that load one without a fake Prisma client must not construct a
// real one just for a token check they never make.
const serviceTokenRows = createServiceTokenCache({
  read: (jti) => require('../prisma/client').serviceToken.findUnique({
    where: { id: jti },
    select: { user_id: true, withdrawn_at: true, expires_at: true },
  }),
});

/**
 * Why this minted token no longer opens a session, or null when it still does.
 * Only for a token tokenLifetimeVerdict sent to 'lookup'. Rejects when the
 * database cannot be read.
 */
async function serviceTokenCheck(decoded) {
  if (!isServiceTokenId(decoded?.jti)) return 'malformed jti';
  const row = await serviceTokenRows.get(decoded.jti);
  return serviceTokenRefusal(decoded, row, Date.now());
}

module.exports = {
  SERVICE_TOKEN_DEFAULT_DAYS,
  SERVICE_TOKEN_CACHE_MS,
  isServiceTokenId,
  tokenLifetimeVerdict,
  serviceTokenRefusal,
  createServiceTokenCache,
  serviceTokenCheck,
};
