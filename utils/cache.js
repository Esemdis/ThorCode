const { v4: uuidv4 } = require("uuid");
const { Redis } = require("ioredis");
const client = new Redis(process.env.REDIS_URL, {
  tls: {},
  retryDelayOnFailover: 300000, // 5 minutes
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  retryDelayOnClusterDown: 300000, // 5 minutes
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

client.on("connect", () => console.log("Redis connected"));
client.on("ready", () => console.log("Redis ready"));
client.on("close", () => console.log("Redis connection closed"));
client.on("reconnecting", () => console.log("Redis reconnecting..."));
client.on("error", (err) => {
  console.error("Redis connection error:", err);
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
async function getCachedData({ key }) {
  const data = await client.get(key);
  return data ? JSON.parse(data) : null;
}
async function deleteCachedData({ key }) {
  await client.del(key);
}
async function clearCache({ prefix }) {
  const keys = await client.keys(`${prefix}:*`);
  if (keys.length > 0) {
    await client.del(keys);
  }
}
module.exports = {
  cacheData,
  getCachedData,
  deleteCachedData,
  clearCache,
};
