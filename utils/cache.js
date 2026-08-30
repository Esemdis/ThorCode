const { v4: uuidv4 } = require("uuid");
const { Redis } = require("ioredis");
const { resolveRedisUrl } = require("./redisUrl");

// Managed instances are reached over rediss:// and need TLS. A self-hosted
// Redis/Valkey on the LAN speaks plain redis:// and will fail the handshake if
// we offer TLS anyway, so only turn it on when the URL asks for it.
const REDIS_URL = resolveRedisUrl();
const useTls = /^rediss:\/\//i.test(REDIS_URL || "");

// Said once, loudly, at boot. ioredis treats a missing url as localhost:6379 and
// every cache miss thereafter looks ordinary, so an environment with no Redis
// configured at all is otherwise indistinguishable from a cold one — it just
// runs everything uncached and slow.
if (!REDIS_URL) {
  console.error(
    "[cache] No REDIS_URL, and no UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN to derive one from. " +
    "Caching is disabled and every cached route will do its full work on every request.",
  );
}

const client = new Redis(REDIS_URL, {
  ...(useTls ? { tls: {} } : {}),
  retryDelayOnFailover: 300000, // 5 minutes
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  retryDelayOnClusterDown: 300000, // 5 minutes
  // Commands issued while the connection is down fail immediately instead of
  // queueing until it comes back. Without this a dead Redis does not disable the
  // cache, it just makes every cached route twelve seconds slower — measured
  // against a REDIS_URL whose host had stopped resolving.
  enableOfflineQueue: false,
  retryStrategy: (times) => {
    // Exponential backoff with max delay of 5 minutes
    const delay = Math.min(times * 2000, 300000); // Max 5 minutes
    console.log(`Redis retry attempt ${times}, waiting ${delay}ms`);
    return delay;
  },
  reconnectOnError: (err) => {
    // Only reconnect on specific errors, not DNS resolution failures
    const targetError = "READONLY";
    return err.message.includes(targetError);
  }
});

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

function generateCacheKey(prefix) {
  return `${prefix}:${uuidv4()}`;
}
async function cacheData({ prefix, data, ttl = 3600 }) {
  try {
    const key = generateCacheKey(prefix);
    await client.set(key, JSON.stringify(data), "EX", ttl);
    return key;
  } catch (error) {
    console.error("Error caching data:", error);
    throw new Error("Failed to cache data");
  }
}
// Reads and deletes answer "nothing there" when Redis is unreachable rather
// than throwing. Only cacheData still throws: a caller storing something it
// intends to read back — OAuth state, in tmdb.js — has to know it did not land,
// whereas a miss is a cache behaving exactly as a cache may.
async function getCachedData({ key }) {
  try {
    const data = await client.get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error("Error reading cached data:", error.message);
    return null;
  }
}
async function deleteCachedData({ key }) {
  try {
    await client.del(key);
  } catch (error) {
    console.error("Error deleting cached data:", error.message);
  }
}
async function clearCache({ prefix }) {
  try {
    const keys = await client.keys(`${prefix}:*`);
    if (keys.length > 0) {
      await client.del(keys);
    }
  } catch (error) {
    console.error("Error clearing cache:", error.message);
  }
}

// Deterministic key helpers for API response caching
async function setCache(key, data, ttl = 3600) {
  try {
    await client.set(key, JSON.stringify(data), 'EX', ttl);
  } catch (err) {
    console.error('Redis setCache error:', err);
  }
}
async function getCache(key) {
  try {
    const data = await client.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    console.error('Redis getCache error:', err);
    return null;
  }
}
async function invalidatePrefix(prefix) {
  try {
    const keys = await client.keys(`${prefix}:*`);
    if (keys.length > 0) await client.del(keys);
  } catch (err) {
    console.error('Redis invalidatePrefix error:', err);
  }
}

module.exports = {
  cacheData,
  getCachedData,
  deleteCachedData,
  clearCache,
  setCache,
  getCache,
  invalidatePrefix,
};
