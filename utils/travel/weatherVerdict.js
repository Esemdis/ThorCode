/**
 * Turns a trip, its forecast and its packing list into the text a model is
 * asked to judge, and checks what comes back.
 *
 * Separate from the route for the same reason as planRequest: everything here
 * is decidable without a network call, so it can be tested, while the route
 * itself is a thin wrapper around one request that cannot be.
 */

// WMO codes, grouped rather than enumerated. The model does not need to know
// that 51 is "light drizzle" and 53 is "moderate drizzle" — it needs to know
// the day is wet, and a band keeps the prompt short enough to stay cheap.
const CODE_BANDS = [
  [[0, 1], 'clear'],
  [[2, 3], 'cloudy'],
  [[45, 48], 'fog'],
  [[51, 57], 'drizzle'],
  [[61, 67], 'rain'],
  [[71, 77], 'snow'],
  [[80, 82], 'rain showers'],
  [[85, 86], 'snow showers'],
  [[95, 99], 'thunderstorm'],
];

function describeCode(code) {
  if (code == null) return null;
  const band = CODE_BANDS.find(([[lo, hi]]) => code >= lo && code <= hi);
  return band ? band[1] : null;
}

// A trip can hold far more days and items than a verdict needs, and the whole
// list goes into every request. These caps bound what one click can cost;
// anything past them is counted rather than listed, so the model still knows
// the list is longer than what it can see.
const MAX_DAYS = 16;
const MAX_ITEMS = 120;

const round = (n) => (n == null ? null : Math.round(n));

// The two date sources in a verdict disagree about type: forecast days come out
// of a JSON column as strings, while start_date and end_date are @db.Date and
// arrive as Date objects. `String(new Date())` is "Mon Aug 10 2026 …", so
// slicing one gives the model "Mon Aug 10" as a date.
function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// Counted from the trip's own dates, not from the forecast: the forecast only
// reaches about two weeks out, and "is four shirts enough" is a question about
// the trip's length rather than about how far the forecast happens to see.
function tripLength(trip) {
  const from = dateOnly(trip?.start_date);
  const to = dateOnly(trip?.end_date);
  if (!from || !to) return null;
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  return Number.isFinite(days) && days > 0 ? days : null;
}

// One line per day. Missing readings are omitted rather than sent as null:
// a gap in the forecast is not information the verdict should reason about.
function forecastLines(days = []) {
  return days.slice(0, MAX_DAYS).map((d) => {
    const parts = [];
    const lo = round(d.temp_min_avg);
    const hi = round(d.temp_max_avg);
    if (lo != null && hi != null) parts.push(`${lo} to ${hi}C`);
    else if (hi != null) parts.push(`max ${hi}C`);

    const sky = describeCode(d.weather_code);
    if (sky) parts.push(sky);

    const mm = d.precip_avg;
    if (mm != null && mm > 0) parts.push(`${Math.round(mm * 10) / 10}mm precipitation`);

    const wind = round(d.wind_avg);
    if (wind != null && wind > 0) parts.push(`wind ${wind}km/h`);

    return `${dateOnly(d.date) ?? ''}: ${parts.join(', ') || 'no reading'}`;
  });
}

// What one item looks like to the model. The gear row behind it carries the
// detail worth judging — a "jacket" that is a 3-layer shell is a different
// answer to rain than a "jacket" that is a denim one — so brand, model and
// tags come along when the item is linked to the closet.
function describeItem(i) {
  const gear = i.gear_item_rel;
  const bits = [i.name];

  // The trip item's own category is usually blank for anything added from the
  // closet, where the category lives on the gear row instead.
  const category = i.category || gear?.category;
  if (category) bits.push(`category: ${category}`);

  if (gear?.brand || gear?.model) bits.push(`gear: ${[gear.brand, gear.model].filter(Boolean).join(' ')}`);
  if (gear?.tags?.length) bits.push(`tags: ${gear.tags.join(', ')}`);
  if (i.worn) bits.push('worn, not packed');
  // Status matters to the verdict: an item still in NEED_TO_BUY is not in
  // the bag, however well it answers the forecast.
  if (i.status && i.status !== 'PACKED') bits.push(`status: ${i.status.toLowerCase().replace(/_/g, ' ')}`);
  if (i.note) bits.push(`note: ${i.note}`);

  return bits.join('; ');
}

// Identical items collapse to one line with a count. Four separate "Merino tee"
// rows are four lines the model has to notice are the same thing before it can
// answer "is that enough shirts for six days" — the count is the part that
// carries meaning, and collapsing them also shortens the prompt.
function groupPacking(items = []) {
  const groups = new Map();
  for (const i of items) {
    const line = describeItem(i);
    groups.set(line, (groups.get(line) || 0) + 1);
  }
  return [...groups.entries()].map(([line, count]) => ({ line, count }));
}

function packingLines(items = []) {
  // Count in front, not trailing: a line ending "tags: wool, base layer x3"
  // reads as a tag called "base layer x3".
  return groupPacking(items)
    .slice(0, MAX_ITEMS)
    .map(({ line, count }) => `- ${count > 1 ? `${count}x ` : ''}${line}`);
}

const SYSTEM_PROMPT = `You read a traveller's packing list against the forecast for their trip and tell them whether the bag is right.

A keyword matcher has already run and the traveller has seen its result. It compares item names to conditions, so it cannot tell a waterproof shell from a denim jacket, notice that the only footwear for a wet week is canvas, or judge whether four shirts covers six days. That judgement is what you add — do not just restate which conditions have a matching word.

Reading the list
- Each line is one item. "x3" means the traveller has three of that same thing.
- Category, brand, model and tags come from the traveller's gear library, and appear only for items linked to it. A bare line means an item typed straight into the trip, not a worse item.
- Tags are free text the traveller wrote themselves. Present, they are good evidence. Absent, they mean nothing at all: an untagged jacket may well be waterproof, so treat a missing tag as unknown, never as a no. Their vocabulary is their own — "shell", "hardshell" and "waterproof" may all mean the same thing here, and one person's "warm" is a fleece where another's is a down jacket.
- Status says whether the thing is actually in the bag. "need to buy" and "bought" are not packed yet and protect nobody.
- "worn, not packed" is being travelled in. It still counts as brought.

What to weigh
- Cover: does anything in the list answer each condition the forecast actually shows? Rain, cold, heat, wind, sun and the swings between them.
- Quantity against trip length: enough of the things worn daily or used up. Judge this against the trip's length, which may run past the end of the forecast.
- Excess: layers or gear the forecast never calls for. Worth a line when it is clearly weight for nothing, not for every spare shirt.

Severity
- high: the traveller ends up cold, soaked, burnt, or unable to do what they came for.
- low: worth knowing, not worth repacking for — small redundancies, mild over-packing, comfort.

Answering
- Judge only against the forecast you are given. Do not assume conditions it does not show, or a climate you associate with the destination.
- When the list genuinely covers the week, say so and return no concerns. Do not manufacture problems to look useful.
- Be concrete and short — one sentence per field. "No waterproof layer for three wet days" beats "consider outerwear".
- The list is what they told the app, not everything they own. Say what the list does not show rather than what they failed to pack.`;

// Kept flat and small on purpose: every optional field is one more thing the
// model can spend tokens on, and one more thing the UI has to handle missing.
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ready', 'minor_gaps', 'serious_gaps'] },
    summary: { type: 'string' },
    concerns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issue: { type: 'string' },
          why: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'low'] },
          suggestion: { type: 'string' },
        },
        required: ['issue', 'why', 'severity'],
      },
    },
  },
  required: ['verdict', 'summary', 'concerns'],
};

class VerdictInputError extends Error {}

/**
 * The user-turn text. Throws rather than asking the model to judge nothing:
 * a trip with no forecast has no question to answer, and a request that
 * cannot produce a verdict should fail before it costs anything.
 */
function buildVerdictInput(trip, items = []) {
  const days = trip?.weather_data?.days || [];
  if (days.length === 0) throw new VerdictInputError('This trip has no forecast yet.');
  if (items.length === 0) throw new VerdictInputError('This trip has nothing packed yet.');

  const length = tripLength(trip);
  const header = [
    `Trip: ${trip.name || 'unnamed'}`,
    trip.destination ? `Destination: ${trip.destination}` : null,
    trip.start_date && trip.end_date
      ? `Dates: ${dateOnly(trip.start_date)} to ${dateOnly(trip.end_date)}`
      : null,
    // Stated rather than left as date arithmetic. Quantity is half the
    // judgement, and a model that miscounts the trip by a day gets every
    // "enough for the week" call slightly wrong.
    length ? `Trip length: ${length} day${length === 1 ? '' : 's'}` : null,
  ].filter(Boolean);

  const groups = groupPacking(items);
  const extraDays = Math.max(0, days.length - MAX_DAYS);
  const extraGroups = Math.max(0, groups.length - MAX_ITEMS);

  // Said plainly when the forecast is shorter than the trip, so the model does
  // not read the days it can see as the whole trip and judge quantity against
  // them.
  const coverage = length && days.length < length
    ? `Forecast covers the first ${days.length} of ${length} days.`
    : null;

  return [
    header.join('\n'),
    '',
    `Forecast (${days.length} day${days.length === 1 ? '' : 's'}):`,
    ...forecastLines(days),
    extraDays > 0 ? `(${extraDays} further day${extraDays === 1 ? '' : 's'} not shown)` : null,
    coverage,
    '',
    `Packing list (${items.length} item${items.length === 1 ? '' : 's'}):`,
    ...packingLines(items),
    extraGroups > 0 ? `(${extraGroups} further kind${extraGroups === 1 ? '' : 's'} of item not shown)` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

const VERDICTS = ['ready', 'minor_gaps', 'serious_gaps'];

/**
 * What the route is willing to hand the UI.
 *
 * The schema is enforced server-side by the provider, but a malformed or
 * half-empty object still reaches here on a bad generation, and the UI should
 * never have to guard every field itself.
 */
function normaliseVerdict(raw) {
  if (!raw || typeof raw !== 'object') throw new VerdictInputError('The model returned nothing usable.');

  const concerns = Array.isArray(raw.concerns) ? raw.concerns : [];

  return {
    verdict: VERDICTS.includes(raw.verdict) ? raw.verdict : 'minor_gaps',
    summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
    concerns: concerns
      .filter((c) => c && typeof c.issue === 'string' && c.issue.trim())
      .map((c) => ({
        issue: c.issue.trim(),
        why: typeof c.why === 'string' ? c.why.trim() : '',
        // Anything not explicitly high is treated as low: a wrong "high" shouts
        // at the user, a wrong "low" only under-sells one line.
        severity: c.severity === 'high' ? 'high' : 'low',
        suggestion: typeof c.suggestion === 'string' && c.suggestion.trim() ? c.suggestion.trim() : null,
      })),
  };
}

module.exports = {
  buildVerdictInput,
  normaliseVerdict,
  VerdictInputError,
  SYSTEM_PROMPT,
  VERDICT_SCHEMA,
  describeCode,
  forecastLines,
  packingLines,
  groupPacking,
  dateOnly,
  tripLength,
  MAX_DAYS,
  MAX_ITEMS,
};
