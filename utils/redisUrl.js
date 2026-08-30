/**
 * Working out where Redis actually is.
 *
 * The Upstash console gives you a REST url and token, so that pair is what ends
 * up in Doppler; ioredis wants a `rediss://` connection string. Deriving one
 * from the other keeps a single set of credentials per environment — the
 * alternative is a duplicated REDIS_URL that silently rots the next time the
 * instance is replaced, which is exactly how the cache came to be pointing at a
 * hostname that no longer resolved.
 */

/**
 * The connection string for ioredis, or null when Redis is not configured.
 *
 * Null rather than undefined on purpose: `new Redis(undefined)` connects to
 * localhost:6379 without complaint, so an unconfigured cache is indistinguishable
 * from an empty one. The caller is expected to check and say so.
 */
function resolveRedisUrl(env = process.env) {
  if (env.REDIS_URL) return env.REDIS_URL;

  const rest = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!rest || !token) return null;

  // Upstash accepts the REST token as the password on the TCP endpoint, under
  // the default user.
  const host = String(rest).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return `rediss://default:${token}@${host}:6379`;
}

module.exports = { resolveRedisUrl };
