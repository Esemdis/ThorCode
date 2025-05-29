const { v4: uuidv4 } = require("uuid");
const { createClient } = require("redis");
const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(console.error);

function generateCacheKey(prefix) {
  return `${prefix}:${uuidv4()}`;
}
async function cacheData({ prefix, data, ttl = 3600 }) {
  const key = generateCacheKey(prefix);
  await redisClient.setEx(key, ttl, JSON.stringify(data));
  return key;
}
async function getCachedData({ key }) {
  const data = await redisClient.get(key);
  return data ? JSON.parse(data) : null;
}
async function deleteCachedData({ key }) {
  await redisClient.del(key);
}
async function clearCache({ prefix }) {
  const keys = await redisClient.keys(`${prefix}:*`);
  if (keys.length > 0) {
    await redisClient.del(keys);
  }
}
module.exports = {
  cacheData,
  getCachedData,
  deleteCachedData,
  clearCache,
};
