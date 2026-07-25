const express = require("express");
const router = express.Router();
const axios = require("axios");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const { getCache, setCache } = require("../../utils/cache");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));

// A past date's ECB reference rates are fixed forever, so the only reason to
// expire them at all is to keep the keyspace from growing without bound.
// `latest` rolls over once a day when the ECB publishes, around 16:00 CET.
const HISTORICAL_TTL = 30 * 24 * 60 * 60;
const LATEST_TTL = 6 * 60 * 60;

// ioredis keeps commands in an offline queue while it reconnects, so a cache
// host that's simply gone (self-hosted box rebooting) would leave this waiting
// indefinitely. The cache is an optimisation on this path, never a dependency:
// give it a moment, then go to the source.
const CACHE_READ_TIMEOUT = 300;
function readCache(key) {
  return Promise.race([
    getCache(key),
    new Promise((resolve) => setTimeout(resolve, CACHE_READ_TIMEOUT, null)),
  ]);
}

// GET /travel/rates?from=EUR,USD&to=SEK&date=2026-07-01
// Returns { rates: { EUR: 11.2, ... }, date } — how much 1 unit of each `from`
// currency is worth in `to`. Uses ECB reference rates via frankfurter.dev;
// historical when `date` is in the past, latest otherwise. Currencies outside
// the ECB set are simply absent from the response.
//
// Responses are cached in Redis: rates aren't user-scoped, so every trip asking
// for the same date and currencies shares one upstream lookup. If the cache is
// unavailable this degrades to calling frankfurter every time, as before.
router.get("/", async (req, res) => {
  // Sorted and deduped so from=EUR,USD and from=USD,EUR share a cache entry.
  const symbols = [...new Set(
    String(req.query.from || "")
      .split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{3}$/.test(s))
  )].sort();
  const base = String(req.query.to || "").trim().toUpperCase();
  if (!symbols.length || !/^[A-Z]{3}$/.test(base)) {
    return res.status(400).json({ error: "Expected from=XXX[,YYY] and to=XXX currency codes" });
  }

  const today = new Date().toISOString().slice(0, 10);
  const date = req.query.date;
  const datePart = date && /^\d{4}-\d{2}-\d{2}$/.test(date) && date < today ? date : "latest";

  const cacheKey = `travel:rates:${datePart}:${base}:${symbols.join(",")}`;
  const cached = await readCache(cacheKey);
  if (cached) return res.json({ data: cached });

  try {
    // Ask for 1 <base> in each foreign currency, then invert to get foreign → base
    const r = await axios.get(`https://api.frankfurter.dev/v1/${datePart}`, {
      params: { base, symbols: symbols.join(",") },
      timeout: 10000,
    });
    const rates = {};
    for (const [c, v] of Object.entries(r.data?.rates || {})) {
      if (v > 0) rates[c] = Math.round((1 / v) * 10000) / 10000;
    }
    const payload = { rates, date: r.data?.date || null };
    res.json({ data: payload });

    // After responding — the client has what it needs, and a slow or missing
    // cache shouldn't be able to delay the answer. setCache swallows its own
    // errors, so this can't reject.
    setCache(cacheKey, payload, datePart === "latest" ? LATEST_TTL : HISTORICAL_TTL);
  } catch (err) {
    res.status(502).json({ error: `Rate lookup failed: ${err.response?.status || err.message}` });
  }
});

module.exports = router;
