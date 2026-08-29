// Calls to the Python sync service, with a fallback host.
//
// The service is a worker, not a lookup: asking it to sync makes it scrape and
// then POST the results into a database through its own backend. That shapes
// the rule below — a fallback must only ever happen when the first host was
// never reached, because a host that answered has already done the work.

const axios = require('axios');

// Errors that mean the request never reached a server. ECONNABORTED is axios's
// own timeout, which belongs here for the same reason: nothing answered.
const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * Whether a failed call should be retried against the fallback host.
 *
 * True only when nothing answered. A 4xx or 5xx means the worker ran and
 * reported a result, so retrying elsewhere would run the same scrape twice
 * rather than fix anything — and an error that never became a request is a bug
 * on this side, which would simply reproduce on the other host.
 *
 * @param {Error} error
 * @returns {boolean}
 */
function shouldFallBack(error) {
  if (!error || error.response) return false;
  return UNREACHABLE.has(error.code) || Boolean(error.request);
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

  try {
    return await client.post(`${primary}${path}`, body, config);
  } catch (error) {
    // Same host in both variables would only repeat the identical failure.
    if (!shouldFallBack(error) || !fallback || fallback === primary) throw error;

    // Said out loud: the work is about to run somewhere other than where the
    // caller thinks it will, and it writes real data when it gets there.
    console.warn(`[python-service] ${primary}${path} unreachable (${error.code || 'no response'}); retrying on ${fallback}`);
    return client.post(`${fallback}${path}`, body, config);
  }
}

module.exports = { shouldFallBack, pythonServicePost };
