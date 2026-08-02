/**
 * Turn a trip and its saved places into the body route-planner expects.
 *
 * This is the only part of day planning with decisions in it, so it is the only
 * part that is a pure function: rows in, request out, no Prisma and no network.
 * The route around it does nothing but load, call this, and post the result.
 *
 * The wire format is documented in travel-bag/docs/route-planner.md, which is
 * the contract all three repos are written against. Times are minutes since
 * local midnight at the destination — not UTC, not timestamps.
 */

// Below this, a day is damp rather than wet. Deliberately the same threshold as
// RAIN_MM in travel-bag/src/utils/weatherAdvice.js, reading the same field of
// the same blob: two different answers to "was it wet on the 15th" in two repos
// would be a bug, and a quiet one.
const RAIN_MM = 1;

// WMO codes that mean precipitation. Millimetres alone miss a day of steady
// drizzle that never adds up, which is exactly the day you want to be indoors.
const isRainCode = (c) => c != null && ((c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95);

// 09:00 to 22:00. Late enough to include dinner, which is a stop like any other
// and has to fit inside the day window or the solver cannot place it.
const DEFAULT_DAY_START = 540;
const DEFAULT_DAY_END = 1320;

const DEFAULT_MEALS = [
  { name: "lunch", window: [720, 870], duration: 60 },
  { name: "dinner", window: [1140, 1290], duration: 90 },
];

// Guards against a mistyped year turning into a 3000-day solve, and against a
// place list long enough to time out. Both are far above a real trip; they are
// here to fail fast with a sentence instead of hanging the request.
const MAX_DAYS = 21;
const MAX_PLACES = 80;

class PlanInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "PlanInputError";
    this.status = 400;
  }
}

/**
 * The calendar day a @db.Date column holds, as YYYY-MM-DD.
 *
 * Prisma hands back a Date pinned to UTC midnight, so reading it in UTC returns
 * exactly the day that was stored. Anything that touches local time — including
 * plain toISOString() on a value built from a local Date — slides the day
 * backwards for anyone west of UTC. Same trap, same rule as travel-bag's
 * src/utils/dates.js.
 */
function dateOnly(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Every calendar day from start to end inclusive.
 *
 * Stops one past MAX_DAYS rather than at it, so an over-long trip comes back
 * visibly over the limit and the caller can say so. Stopping *at* the limit
 * would quietly plan the first three weeks of a mistyped six-month trip.
 */
function datesBetween(start, end) {
  const out = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last && out.length <= MAX_DAYS) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Which dates the forecast says will be wet.
 *
 * Missing weather is not "dry" — it is unknown, and the solver treats a day
 * without `wet` as having nothing to say about the weather rather than as a
 * guarantee of sunshine.
 */
function wetDates(weatherData) {
  const days = weatherData?.days;
  if (!Array.isArray(days)) return new Set();
  return new Set(
    days
      .filter((d) => (d?.precip_avg ?? 0) >= RAIN_MM || isRainCode(d?.weather_code))
      .map((d) => dateOnly(d?.date))
      .filter(Boolean)
  );
}

// Mirrors DEFAULT_DURATION in route-planner's planner.py. Duplicated rather
// than passed, because it is only needed to know how late a booking runs, and
// getting it slightly wrong widens a day window by a few minutes at worst.
const ASSUMED_DURATION = 60;

// 04:00, i.e. past midnight. Minutes are counted from the *start* of the day and
// are not wrapped, so a concert at 22:30 that runs two hours ends at 1470 and
// has to be expressible or it comes back as a time conflict. Capped rather than
// unbounded because a day ending at 09:00 the next morning is a typo, not a
// night out — and the cap is what stops one from silently becoming a two-day
// window the solver can fill.
const MAX_DAY_END = 1680;

// A day window has to cover getting *home*, not just the last thing you do —
// the solver puts the hotel at both ends and the return leg has to land inside
// it. The real travel time is only known to the solver, which owns the matrix,
// so this is a generous guess on purpose: too wide costs nothing, because the
// solver already minimises when the day actually finishes, while too tight
// silently drops the booking the window was widened for.
const RETURN_ALLOWANCE = 90;

/**
 * Stretch a day to fit any booking that has to happen on it.
 *
 * The default day is 09:00–22:00, which is right for sightseeing and wrong for
 * the 22:30 event somebody has tickets to. Without this that booking simply
 * does not fit, comes back as dropped, and there is nothing in the UI that
 * looks like the cause — the place is open, the time is set, and the day window
 * that actually refused it is invisible.
 *
 * A booking with no pinned day could land on any of them, so it widens all of
 * them. That is the honest reading, and the alternative — refusing to schedule
 * an unpinned late booking anywhere — is worse.
 */
function dayBounds(places, date, dayStart, dayEnd) {
  let start = dayStart;
  let end = dayEnd;

  for (const place of places) {
    if (place.arrive_after == null && place.arrive_by == null) continue;
    const pinned = dateOnly(place.pinned_day);
    if (pinned && pinned !== date) continue;

    const earliest = place.arrive_after ?? place.arrive_by;
    const latest = (place.arrive_by ?? place.arrive_after)
      + (place.duration ?? ASSUMED_DURATION) + RETURN_ALLOWANCE;
    // Getting there is symmetric: an 06:00 booking needs the day to have begun
    // early enough to travel to it.
    start = Math.min(start, earliest - RETURN_ALLOWANCE);
    end = Math.max(end, latest);
  }
  return { start: Math.max(0, start), end: Math.min(MAX_DAY_END, end) };
}

/**
 * The hotel each day starts and ends at.
 *
 * A hotel with `pinned_day` set takes over from that date onwards, so "we move
 * across town on the 16th" needs no second trip and no extra column. Days before
 * the first pinned hotel fall back to an unpinned one — the common case, where
 * there is exactly one hotel and no pin at all.
 */
function hotelForDate(hotels, date) {
  const pinned = hotels
    .filter((h) => dateOnly(h.pinned_day))
    .sort((a, b) => dateOnly(a.pinned_day).localeCompare(dateOnly(b.pinned_day)));

  let chosen = null;
  for (const hotel of pinned) {
    if (dateOnly(hotel.pinned_day) <= date) chosen = hotel;
  }
  if (chosen) return chosen;

  return hotels.find((h) => !dateOnly(h.pinned_day)) ?? pinned[0] ?? null;
}

/** A stored row as the solver's Place shape. */
function toPlace(row) {
  const place = {
    id: row.id,
    name: row.name,
    lat: row.lat ?? null,
    lon: row.lon ?? null,
    // The database stores SIGHT/FOOD/HOTEL because that is how enums are spelled
    // in this schema; the solver contract says lowercase. Converting here keeps
    // the mismatch in one line rather than in every consumer.
    kind: String(row.kind || "SIGHT").toLowerCase(),
    priority: row.priority ?? 3,
    outdoor: Boolean(row.outdoor),
  };
  // Omitted rather than sent as null: the solver's own defaults are the right
  // answer for "not specified", and an explicit null would override them.
  if (row.duration != null) place.duration = row.duration;
  if (row.hours) place.hours = row.hours;
  if (row.arrive_after != null) place.arrive_after = row.arrive_after;
  if (row.arrive_by != null) place.arrive_by = row.arrive_by;
  if (row.ignore_hours) place.ignore_hours = true;
  const pinned = dateOnly(row.pinned_day);
  if (pinned) place.pinned_day = pinned;
  if (row.note) place.notes = row.note;
  return place;
}

/**
 * Build the solve request.
 *
 * @param {object} trip   Trip row: start_date, end_date, weather_data
 * @param {Array}  places TripPlace rows, hotels included
 * @param {object} options mode, max_per_day, time_limit_s, balance, transit,
 *                         day_start, day_end, meals
 * @returns {object} the request body for POST /plan
 * @throws {PlanInputError} when the trip cannot be planned at all
 */
function buildPlanRequest(trip, places = [], options = {}) {
  const start = dateOnly(trip?.start_date);
  const end = dateOnly(trip?.end_date);
  if (!start || !end) {
    throw new PlanInputError("Add start and end dates to the trip before planning it");
  }
  if (end < start) {
    throw new PlanInputError("The trip ends before it starts");
  }

  const dates = datesBetween(start, end);
  if (dates.length > MAX_DAYS) {
    throw new PlanInputError(`Trips longer than ${MAX_DAYS} days cannot be planned in one go`);
  }
  if (places.length > MAX_PLACES) {
    throw new PlanInputError(`Too many places to plan at once — keep it under ${MAX_PLACES}`);
  }

  const hotels = places.filter((p) => p.kind === "HOTEL");
  if (hotels.length === 0) {
    throw new PlanInputError("Add a hotel — every day has to start and end somewhere");
  }
  if (!hotels.some((h) => h.lat != null && h.lon != null)) {
    throw new PlanInputError("The hotel needs coordinates before a route can be planned");
  }

  const wet = wetDates(trip?.weather_data);
  const dayStart = options.day_start ?? DEFAULT_DAY_START;
  const dayEnd = options.day_end ?? DEFAULT_DAY_END;

  const days = dates.map((date) => {
    const hotel = hotelForDate(hotels, date);
    return {
      date,
      ...dayBounds(places, date, dayStart, dayEnd),
      hotel_id: hotel.id,
      wet: wet.has(date),
    };
  });

  return {
    days,
    places: places.map(toPlace),
    meals: options.meals ?? DEFAULT_MEALS,
    mode: options.mode ?? "foot",
    max_per_day: options.max_per_day ?? 8,
    time_limit_s: options.time_limit_s ?? 10,
    ...(options.balance != null && { balance: options.balance }),
    ...(options.transit != null && { transit: Boolean(options.transit) }),
  };
}

module.exports = {
  buildPlanRequest,
  PlanInputError,
  // Exported for the tests, which pin the rules rather than the whole request.
  dateOnly,
  datesBetween,
  wetDates,
  hotelForDate,
  dayBounds,
  toPlace,
  DEFAULT_MEALS,
  MAX_DAYS,
  MAX_PLACES,
};
