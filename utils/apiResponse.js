/**
 * Standardized API response format
 * All endpoints should use these helpers for consistent responses
 *
 * Two families live here. The `success`/`error` pair and its status-code
 * shorthands wrap a body in { success, ... }. Below them are the helpers the
 * list-and-write routes use: `fail` for reporting a caught error safely, and
 * `paginate`/`sendList` for bounding a collection.
 */

/**
 * Send success response
 * @param {object} res - Express response object
 * @param {number} status - HTTP status code
 * @param {object} data - Response data
 * @param {string} message - Optional message
 */
function success(res, status = 200, data = {}, message = '') {
  return res.status(status).json({
    success: true,
    data,
    ...(message && { message }),
  });
}

/**
 * Send error response
 * @param {object} res - Express response object
 * @param {number} status - HTTP status code
 * @param {string} error - Error message
 */
function error(res, status = 500, error) {
  return res.status(status).json({
    success: false,
    error,
  });
}

// The shorthands below call `error` directly rather than `this.error`. Reaching
// through `this` only works while the module is called as an object
// (`response.badRequest(…)`); the moment anyone destructures the import, `this`
// is undefined and the call throws.

/**
 * 400 Bad Request
 */
function badRequest(res, message) {
  return error(res, 400, message);
}

/**
 * 401 Unauthorized
 */
function unauthorized(res, message = 'Unauthorized') {
  return error(res, 401, message);
}

/**
 * 403 Forbidden
 */
function forbidden(res, message = 'Forbidden') {
  return error(res, 403, message);
}

/**
 * 404 Not Found
 */
function notFound(res, message = 'Not found') {
  return error(res, 404, message);
}

/**
 * 409 Conflict
 */
function conflict(res, message) {
  return error(res, 409, message);
}

/**
 * 500 Internal Server Error
 */
function serverError(res, message = 'Internal server error') {
  return error(res, 500, message);
}

// ── Caught errors, and bounded lists ────────────────────────────────────────

// Prisma's "required record not found" — thrown by update/delete when the
// `where` matched nothing. Every write scopes its where to the caller's own
// rows, so a miss means either "no such row" or "not yours", and both get the
// same answer, with no hint about which.
const RECORD_NOT_FOUND = 'P2025';

// Read at call time, not at require time: whichever module loads dotenv first
// is not this one's business.
const inProduction = () => process.env.NODE_ENV === 'production';

/**
 * Report a caught error without handing the client the internals.
 *
 * Database errors carry table names, column names, constraint names and
 * sometimes the offending value. The log gets all of it; the client gets a
 * sentence. In development the detail stays in the response, where the person
 * reading it is the person who wrote the query.
 *
 * Pass `notFound` and a Prisma P2025 becomes a 404 with that message — which is
 * what lets a write be a single query instead of a check followed by a write.
 *
 * @param {object} res - Express response object
 * @param {Error} err - The caught error
 * @param {{ context?: string, notFound?: string, message?: string }} options
 */
function fail(res, err, { context, notFound: notFoundMessage, message = 'Something went wrong' } = {}) {
  if (notFoundMessage && err?.code === RECORD_NOT_FOUND) {
    return error(res, 404, notFoundMessage);
  }
  console.error(`[${new Date().toISOString()}] ${context || 'request failed'}`, err);
  return error(res, 500, inProduction() ? message : err?.message || message);
}

/**
 * Read ?limit= and ?offset=, clamped.
 *
 * The defaults sit well above what one person accumulates, so existing clients
 * keep seeing whole lists; they exist to stop an account's growth from turning
 * into an unbounded response. Anything unparseable falls back to the default
 * rather than erroring — a malformed page number shouldn't fail the request.
 */
function paginate(req, { defaultLimit = 100, maxLimit = 500 } = {}) {
  const asInt = (value, fallback) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  const take = Math.min(Math.max(asInt(req.query.limit, defaultLimit), 1), maxLimit);
  const skip = Math.max(asInt(req.query.offset, 0), 0);
  return { take, skip };
}

/**
 * Send a page of rows: the { data } shape every client already reads, plus the
 * counts needed to ask for the next one. X-Total-Count is there for anything
 * that would rather read a header than the body.
 */
function sendList(res, rows, { total, take, skip }) {
  res.set('X-Total-Count', String(total));
  return res.json({
    success: true,
    data: rows,
    meta: { total, limit: take, offset: skip, has_more: skip + rows.length < total },
  });
}

module.exports = {
  success,
  error,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  serverError,
  fail,
  paginate,
  sendList,
  RECORD_NOT_FOUND,
};
