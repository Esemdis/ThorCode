/**
 * Ask for a packing verdict and print it, without a database.
 *
 *   doppler run -- node scripts/verdict-demo.js
 *
 * Exercises everything ThorCode contributes to the forecast check — building
 * the prompt from rows, calling Gemini, reading the answer back — against a
 * fixture trip, so the whole path can be checked before any of it is wired to
 * Postgres or to a UI. The key lives in Doppler, so this needs `doppler run`;
 * without it the SDK sees no key and the failure looks like a config bug.
 *
 * A verdict is judged by reading it. Assertions can tell you the JSON parsed;
 * they cannot tell you the answer is one worth showing someone.
 */

require("dotenv").config();

const { GoogleGenAI } = require("@google/genai");
const {
  buildVerdictInput,
  normaliseVerdict,
  SYSTEM_PROMPT,
  VERDICT_SCHEMA,
} = require("../utils/travel/weatherVerdict");

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";

// A week in Bergen with a hole in it: three wet days, nothing waterproof, one
// pair of canvas shoes, and the warm layer still unbought. If the verdict does
// not find those, the prompt is not doing its job.
const TRIP = {
  name: "Bergen hiking",
  destination: "Bergen, Norway",
  start_date: new Date("2026-08-10T00:00:00.000Z"),
  end_date: new Date("2026-08-16T00:00:00.000Z"),
  weather_data: {
    days: [
      { date: "2026-08-10", weather_code: 63, temp_min_avg: 9.4, temp_max_avg: 15.1, precip_avg: 8.2, wind_avg: 22 },
      { date: "2026-08-11", weather_code: 61, temp_min_avg: 10, temp_max_avg: 16, precip_avg: 4.3, wind_avg: 18 },
      { date: "2026-08-12", weather_code: 3, temp_min_avg: 11, temp_max_avg: 18, precip_avg: 0, wind_avg: 12 },
      { date: "2026-08-13", weather_code: 80, temp_min_avg: 8, temp_max_avg: 14, precip_avg: 6, wind_avg: 30 },
      { date: "2026-08-14", weather_code: 2, temp_min_avg: 10, temp_max_avg: 17, precip_avg: 0.2, wind_avg: 14 },
    ],
  },
};

const tee = {
  name: "Merino tee", category: null, status: "PACKED",
  gear_item_rel: { brand: "Icebreaker", model: "150", tags: ["wool", "base layer"], category: "Clothing" },
};

const ITEMS = [
  tee, tee, tee,
  { name: "Canvas sneakers", category: "Footwear", status: "PACKED", worn: true },
  { name: "Fleece", category: null, status: "NEED_TO_BUY", gear_item_rel: { brand: "Patagonia", tags: ["warm"], category: "Clothing" } },
  { name: "Daypack", category: null, status: "PACKED", note: "rain cover included", gear_item_rel: { brand: "Osprey", model: "Talon 22", tags: [], category: "Bags" } },
  { name: "Jeans", category: "Clothing", status: "PACKED" },
];

const rule = (label) => console.log(`\n${"─".repeat(8)} ${label} ${"─".repeat(8)}`);

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set. The key lives in Doppler — run this as:\n");
    console.error("  doppler run -- node scripts/verdict-demo.js\n");
    process.exit(1);
  }

  const input = buildVerdictInput(TRIP, ITEMS);

  rule("prompt sent");
  console.log(input);

  rule(`calling ${MODEL}`);
  const started = Date.now();

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const interaction = await ai.interactions.create({
    model: MODEL,
    system_instruction: SYSTEM_PROMPT,
    input,
    response_format: { type: "text", mime_type: "application/json", schema: VERDICT_SCHEMA },
  });

  console.log(`answered in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  rule("raw output_text");
  console.log(interaction.output_text);

  const verdict = normaliseVerdict(JSON.parse(interaction.output_text));

  rule("what the UI would render");
  console.log(`verdict: ${verdict.verdict}`);
  console.log(`summary: ${verdict.summary}`);
  for (const c of verdict.concerns) {
    console.log(`\n  [${c.severity}] ${c.issue}`);
    if (c.why) console.log(`        ${c.why}`);
    if (c.suggestion) console.log(`      → ${c.suggestion}`);
  }
  console.log();
}

main().catch((err) => {
  // The two failures worth naming: a key the API rejects, and a quota that is
  // spent. Everything else is worth seeing whole.
  if (err?.status === 401 || err?.status === 403) {
    console.error("\nGemini rejected the key. Check the GEMINI_API_KEY value in Doppler.");
  } else if (err?.status === 429) {
    console.error("\nGemini quota is spent for now — the key works, but it is rate limited.");
  }
  console.error(err);
  process.exit(1);
});
