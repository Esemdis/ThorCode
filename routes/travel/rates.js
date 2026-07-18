const express = require("express");
const router = express.Router();
const axios = require("axios");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));

// GET /travel/rates?from=EUR,USD&to=SEK&date=2026-07-01
// Returns { rates: { EUR: 11.2, ... }, date } — how much 1 unit of each `from`
// currency is worth in `to`. Uses ECB reference rates via frankfurter.dev;
// historical when `date` is in the past, latest otherwise. Currencies outside
// the ECB set are simply absent from the response.
router.get("/", async (req, res) => {
  const symbols = String(req.query.from || "")
    .split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{3}$/.test(s));
  const base = String(req.query.to || "").trim().toUpperCase();
  if (!symbols.length || !/^[A-Z]{3}$/.test(base)) {
    return res.status(400).json({ error: "Expected from=XXX[,YYY] and to=XXX currency codes" });
  }

  const today = new Date().toISOString().slice(0, 10);
  const date = req.query.date;
  const datePart = date && /^\d{4}-\d{2}-\d{2}$/.test(date) && date < today ? date : "latest";

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
    res.json({ data: { rates, date: r.data?.date || null } });
  } catch (err) {
    res.status(502).json({ error: `Rate lookup failed: ${err.response?.status || err.message}` });
  }
});

module.exports = router;
