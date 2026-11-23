const express = require("express");
const { GoogleGenAI } = require("@google/genai");
const router = express.Router({ mergeParams: true });

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const ownsTrip = require("../../middlewares/ownsTrip");
const prisma = require("../../prisma/client");
const { fail } = require("../../utils/apiResponse");
const { rateLimiter } = require("../../utils/rateLimiter");
const {
  buildVerdictInput,
  normaliseVerdict,
  VerdictInputError,
  SYSTEM_PROMPT,
  VERDICT_SCHEMA,
} = require("../../utils/travel/weatherVerdict");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));
router.use(ownsTrip);

// Flash models are the free-tier ones; overridable so the model can be moved
// without a deploy. Keep it a Flash or Flash-Lite variant — the Pro models are
// not on the free tier.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";

// The call had no timeout, so a slow answer held the request open for as long as the SDK
// waited, and the SDK retries by default, which makes it longer (THO-1007). A verdict is a
// few hundred tokens: thirty seconds is a long wait for one, and no retry, because the
// click can simply be made again and a retry doubles the cost of a call that already ran
// out of time.
const GEMINI_TIMEOUT_MS = 30_000;

// Much tighter than the /travel/* write limit this route already sits behind.
// That one is sized for database writes at 60/min; every request here spends a
// third party's quota, and on the free tier a burst at that rate exhausts the
// day's allowance in a couple of minutes. Per IP, like its parent.
const verdictLimit = rateLimiter({
  windowMs: 60 * 1000,
  max: 6,
  message: "Give the forecast check a moment before asking again.",
});

// POST rather than GET despite reading nothing: it costs money and quota, so it
// must not be something a browser or crawler can fire by following a link.
router.post("/", verdictLimit, async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      // A missing key is a deployment problem, not the caller's fault — say so
      // rather than surfacing whatever the SDK throws on an empty key.
      return res.status(503).json({ error: "The packing verdict is not configured on this server." });
    }

    const [trip, items] = await Promise.all([
      prisma.trip.findUnique({
        where: { id: req.tripId },
        select: {
          name: true, destination: true, start_date: true, end_date: true, weather_data: true,
        },
      }),
      prisma.tripItem.findMany({
        where: { trip_id: req.tripId },
        orderBy: { sort_order: "asc" },
        select: {
          name: true, category: true, status: true, note: true, worn: true,
          gear_item_rel: { select: { brand: true, model: true, tags: true, category: true } },
        },
      }),
    ]);

    if (!trip) return res.status(404).json({ error: "Trip not found." });

    // Throws VerdictInputError when there is nothing to judge, which is a
    // 400 rather than a failed generation — no request is made at all.
    const input = buildVerdictInput(trip, items);

    // v1beta named outright: @google/genai 3.0 changed its default to v1, and this is the
    // Interactions API, whose path carries the version. 2.x called /v1beta/interactions.
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });

    const interaction = await ai.interactions.create({
      model: MODEL,
      system_instruction: SYSTEM_PROMPT,
      input,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: VERDICT_SCHEMA,
      },
    }, { timeout: GEMINI_TIMEOUT_MS, maxRetries: 0 });

    let parsed;
    try {
      parsed = JSON.parse(interaction.output_text);
    } catch {
      // The schema is enforced provider-side, so this means a truncated or
      // empty generation rather than the model ignoring the shape.
      return res.status(502).json({ error: "The packing verdict came back unreadable. Try again." });
    }

    res.json({ data: normaliseVerdict(parsed), meta: { model: MODEL } });
  } catch (err) {
    if (err instanceof VerdictInputError) {
      return res.status(400).json({ error: err.message });
    }
    // The SDK's own client-side timeout (APIConnectionTimeoutError), or a timer that fired.
    // Nothing is wrong with the trip: the model was slow, and the answer is to try again.
    if (err?.name === "APIConnectionTimeoutError" || err?.name === "TimeoutError") {
      return res.status(504).json({ error: "The packing verdict took too long. Try again." });
    }
    // Quota exhaustion is the expected failure on a free key, and it is worth
    // distinguishing: nothing is wrong with the trip or the server, and the
    // answer is to wait rather than to retry immediately.
    if (err?.status === 429) {
      return res.status(429).json({ error: "The forecast check has hit its daily free quota. Try again tomorrow." });
    }
    fail(res, err, { context: `POST weather-verdict (trip ${req.tripId})` });
  }
});

module.exports = router;
