// Calls to the Python sync service, with a fallback host.
//
// The service is a worker, not a lookup: asking it to sync makes it scrape and
// then POST the results into a database through its own backend. That shapes
// the rule below — a fallback must only ever happen when the first host was
// never reached, because a host that answered has already done the work.

const axios = require('axios');

// Errors that mean the request never reached a server: no name, no route, no
// listener, no connection made.
const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

// Errors after the request was sent, with no answer back. The worker may well
// have it and be scraping: ECONNABORTED is axios's own timeout — five minutes
// on the weather and setlist syncs, which is a job still running, not a host
// that was never there — and ECONNRESET can drop a connection mid-response.
// These used to count as unreachable, so a slow sync ran a second time on the
// fallback host, which is the one thing the fallback promises never to do.
const NO_ANSWER = new Set(['ECONNABORTED', 'ECONNRESET', 'EPIPE']);

/**
 * Whether a failed call should be retried against the fallback host.
 *
 * True only when the request provably never arrived. A 4xx or 5xx means the
 * worker ran and reported a result, and a timeout or a reset may mean it is
 * still running — either way retrying elsewhere would run the same scrape
 * twice rather than fix anything. An error that never became a request is a
 * bug on this side, which would simply reproduce on the other host.
 *
 * @param {Error} error
 * @returns {boolean}
 */
function shouldFallBack(error) {
  if (!error || error.response) return false;
  return UNREACHABLE.has(error.code);
}

/**
 * POST to the Python sync service, falling back to a second host if the first
 * cannot be reached.
 *
 * The fallback comes from `PYTHON_SERVICE_FALLBACK_URL` rather than a constant,
 * so production can leave it unset and never fall back to itself.
 *
 * @param {string} path - Leading slash, e.g. '/trigger'.
 * @param {object} [body]
 * @param {object} [config] - Passed to axios; timeouts belong here.
 * @param {{ post: Function }} [client] - HTTP client; injectable so the
 *   fallback logic can be tested without a network or a module mock. Vitest
 *   externalises axios for this CommonJS module, so mocking it does not take.
 * @returns {Promise<import('axios').AxiosResponse>}
 */
async function pythonServicePost(path, body = {}, config = {}, client = axios) {
  const primary = process.env.PYTHON_SERVICE_URL;
  const fallback = process.env.PYTHON_SERVICE_FALLBACK_URL;

  // The Python service's mutating endpoints (/sync/*, /trigger, ...) now
  // require this shared secret, since they used to accept unauthenticated
  // requests that could point their scraper at an arbitrary URL (SSRF).
  const authConfig = {
    ...config,
    headers: { ...config.headers, Authorization: `Bearer ${process.env.SCRAPER_TOKEN}` },
  };

  try {
    return await client.post(`${primary}${path}`, body, authConfig);
  } catch (error) {
    // Same host in both variables would only repeat the identical failure.
    if (!shouldFallBack(error) || !fallback || fallback === primary) throw error;

    // Said out loud: the work is about to run somewhere other than where the
    // caller thinks it will, and it writes real data when it gets there.
    console.warn(`[python-service] ${primary}${path} unreachable (${error.code || 'no response'}); retrying on ${fallback}`);
    return client.post(`${fallback}${path}`, body, authConfig);
  }
}

/**
 * The client-facing status and message for a failed call to the sync service.
 *
 * Every one of these used to become `500 { error: err.message }`, which put
 * axios's own "Request failed with status code 401" in front of an admin — a
 * status their login had nothing to do with, naming nothing they could go and
 * fix. It cost an afternoon to trace back to an unset shared secret, so the
 * credential case says which secret and where.
 *
 * 502 for anything the service answered, rather than passing its status
 * through: the sync service's 401 is not this API's 401, and a 500 here would
 * claim the fault was local. 503 is kept for the one case where nothing
 * answered, because that is the only one where no work happened and retrying
 * costs nothing.
 *
 * @param {Error} error - The error thrown by `pythonServicePost`.
 * @returns {{ status: number, message: string }}
 */
function pythonServiceFailure(error) {
  const upstream = error?.response?.status;

  if (upstream === 401 || upstream === 403) {
    return {
      status: 502,
      message:
        'The sync service rejected our credentials. Check that SCRAPER_TOKEN is set '
        + 'to the same value on this API and on the sync service.',
    };
  }

  if (upstream) {
    return { status: 502, message: `The sync service answered ${upstream}.` };
  }

  // Reuses the reachability rule rather than restating it, so "never
  // reached" cannot come to mean two different things in one file.
  if (shouldFallBack(error)) {
    return { status: 503, message: 'The sync service could not be reached.' };
  }

  // Sent, and no answer: not safe to call a failure, since the job may be
  // running, and not a fault on this side either.
  if (NO_ANSWER.has(error?.code) || error?.request) {
    return { status: 504, message: 'The sync service did not answer in time. The job may still be running.' };
  }

  return { status: 500, message: 'The sync request could not be sent.' };
}

module.exports = { shouldFallBack, pythonServicePost, pythonServiceFailure };
