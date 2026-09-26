const { Redis } = require("ioredis");
const { resolveRedisUrl } = require("./redisUrl");

// Managed instances are reached over rediss:// and need TLS. A self-hosted
// Redis/Valkey on the LAN speaks plain redis:// and will fail the handshake if
// we offer TLS anyway, so only turn it on when the URL asks for it.
const REDIS_URL = resolveRedisUrl();
const useTls = /^rediss:\/\//i.test(REDIS_URL || "");

// Said once, loudly, at boot. Caching is an optimisation everywhere it is used,
// so an environment with no Redis runs, just uncached and slower — which is
// otherwise indistinguishable from a cold cache.
//
// And no client at all in that case. `new Redis(null)` quietly means
// localhost:6379, so the "disabled" cache used to dial a Redis that was never
// there, retry it forever, log every attempt, and keep any script that loaded
// this module from exiting.
if (!REDIS_URL) {
  console.error(
    "[cache] No REDIS_URL, and no UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN to derive one from. " +
    "Caching is disabled and every cached route will do its full work on every request.",
  );
}

const client = REDIS_URL ? new Redis(REDIS_URL, {
  ...(useTls ? { tls: {} } : {}),
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  // Commands issued while the connection is down fail immediately instead of
  // queueing until it comes back. Without this a dead Redis does not disable the
  // cache, it just makes every cached route twelve seconds slower — measured
  // against a REDIS_URL whose host had stopped resolving.
  enableOfflineQueue: false,
  retryStrategy: (times) => {
    // Linear backoff, two seconds a step, capped at five minutes.
    const delay = Math.min(times * 2000, 300000);
    console.log(`Redis retry attempt ${times}, waiting ${delay}ms`);
    return delay;
  },
  reconnectOnError: (err) => {
    // Only reconnect on specific errors, not DNS resolution failures
    const targetError = "READONLY";
    return err.message.includes(targetError);
  }
}) : null;

if (client) {
  // lazyConnect means nothing dials Redis until the first command, and with the
  // offline queue off that first command would fail while the handshake is still
  // in flight. Kick it here so the connection is either up or known-down by the
  // time a request needs it.
  client.connect().catch(() => {});

  client.on("connect", () => console.log("Redis connected"));
  client.on("ready", () => console.log("Redis ready"));
  client.on("close", () => console.log("Redis connection closed"));
  client.on("reconnecting", () => console.log("Redis reconnecting..."));
  client.on("error", (err) => {
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      // Log once per unique hostname, not on every retry
      if (!client._lastDnsError || client._lastDnsError !== err.hostname) {
        client._lastDnsError = err.hostname;
        console.warn(`Redis unavailable (${err.code}: ${err.hostname ?? err.address}). Cache disabled.`);
      }
    } else {
      console.error('Redis connection error:', err);
    }
  });
}

// Deterministic key helpers for API response caching. Both answer as a cache
// may when Redis is missing or down — a miss, a write that did not land —
// rather than throwing: nothing here is a dependency.
async function setCache(key, data, ttl = 3600) {
  if (!client) return;
  try {
    await client.set(key, JSON.stringify(data), 'EX', ttl);
  } catch (err) {
    console.error('Redis setCache error:', err);
  }
}
async function getCache(key) {
  if (!client) return null;
  try {
    const data = await client.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    console.error('Redis getCache error:', err);
    return null;
  }
}

module.exports = {
  setCache,
  getCache,
};
