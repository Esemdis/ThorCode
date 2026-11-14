/**
 * What the app-wide error handler writes to the log.
 *
 * Neither the error nor its message is safe to log when body-parser raised it.
 * It attaches the raw request body to the error (`body: str`, read.js:197 in
 * 2.4.0), so a login, reset or OAuth request cut short put its password, token
 * or code in `docker logs`, up to the 10,000 characters util.inspect prints.
 * Dropping `err.body` is not enough either: V8's JSON.parse "Unexpected token"
 * message quotes about ten characters of the input either side of the error
 * (`..."password":hunter2sec"... is not valid JSON`), and the stack repeats it.
 * So a parser error is logged by its status and type alone, which still says
 * what happened.
 *
 * An axios error carries its request config, and with it the outbound
 * `Authorization` header (the sync service's SCRAPER_TOKEN, a Spotify bearer).
 * Express 5 forwards a rejected async handler here, so it is cut down to the
 * upstream status, or the message when there was no answer.
 *
 * Everything else, a Prisma or fs failure, is logged whole, stack included:
 * that is what the log is for.
 */
function isBodyParserError(err) {
  if (err === null || typeof err !== 'object') return false;
  return typeof err.type === 'string' || Object.hasOwn(err, 'body');
}

function logFieldsFor(err) {
  if (isBodyParserError(err)) return [`${err.status ?? 400} ${err.type ?? 'body error'}`];
  if (err?.isAxiosError) return [err.response?.status ?? err.message];
  return [err];
}

// Anything that escapes a route. A deliberate 4xx keeps its message — it was
// written to be read — but a 500 is an internal detail (table names, constraint
// names, sometimes values), so outside development the client just gets told it
// broke and the log keeps the rest.
function errorHandler(err, req, res, _next) {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`, ...logFieldsFor(err));
  const status = err.status ?? 500;
  const message = status < 500 || process.env.NODE_ENV !== 'production'
    ? err.message || 'Internal server error'
    : 'Internal server error';
  res.status(status).json({ error: message });
}

module.exports = { errorHandler, logFieldsFor };
