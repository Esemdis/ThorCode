/**
 * Validate and normalise what a client sends when saving a place.
 *
 * Separate from planRequest.js because it answers a different question: that one
 * asks "what does the solver need", this one asks "is this safe to store". The
 * awkward part is `hours`, which is free-form JSON in the database and the one
 * field where a malformed value survives the write and only fails later, inside
 * the solver, as a trip that mysteriously plans nothing.
 */

const KINDS = ["SIGHT", "FOOD", "HOTEL"];
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const MINUTES_IN_DAY = 1440;
// Nothing worth visiting takes twelve hours, and a duration longer than a day
// makes every day window unsatisfiable — which reads to the user as "the solver
// ignored my place" rather than as the typo it is.
const MAX_DURATION_MIN = 720;

/**
 * Check an opening-hours object.
 *
 * The shape is `{ "tue": [[570, 1080]] }` — per weekday, a list of [open, close]
 * minute pairs, so split hours are two pairs. An explicit `[]` means closed that
 * day; a weekday simply absent means unknown, which the solver reads as open.
 *
 * Returns an error string, or null when it is fine.
 */
function checkHours(hours) {
  if (hours == null) return null;
  if (typeof hours !== "object" || Array.isArray(hours)) {
    return "hours must be an object keyed by weekday";
  }

  for (const [day, windows] of Object.entries(hours)) {
    if (!WEEKDAYS.includes(day)) {
      return `hours has an unknown weekday "${day}" — use ${WEEKDAYS.join(", ")}`;
    }
    if (!Array.isArray(windows)) {
      return `hours.${day} must be a list of [open, close] pairs`;
    }
    for (const window of windows) {
      if (!Array.isArray(window) || window.length !== 2) {
        return `hours.${day} must contain [open, close] pairs`;
      }
      const [open, close] = window;
      if (!Number.isInteger(open) || !Number.isInteger(close)) {
        return `hours.${day} times must be whole minutes since midnight`;
      }
      if (open < 0 || close > MINUTES_IN_DAY) {
        return `hours.${day} times must be between 0 and ${MINUTES_IN_DAY}`;
      }
      // Equal, not just inverted: a zero-length window is never satisfiable and
      // is always a mistake, usually 1080–1080 from a form that defaulted both.
      if (close <= open) {
        return `hours.${day} closes at or before it opens`;
      }
    }
  }
  return null;
}

/**
 * Normalise a create/update body into columns.
 *
 * `partial` is what separates a PATCH from a POST: on a create, absent fields
 * take their defaults, and on an update, absent fields must stay absent so they
 * are not overwritten with them.
 *
 * Returns `{ data }` or `{ error }`.
 */
function normalisePlaceInput(body = {}, { partial = false } = {}) {
  const data = {};

  if (body.name !== undefined || !partial) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return { error: "A place needs a name" };
    if (name.length > 200) return { error: "That name is too long" };
    data.name = name;
  }

  if (body.kind !== undefined) {
    const kind = String(body.kind).toUpperCase();
    if (!KINDS.includes(kind)) return { error: `kind must be one of ${KINDS.join(", ")}` };
    data.kind = kind;
  }

  if (body.lat !== undefined || body.lon !== undefined) {
    // undefined has to fold into null here, not into Number(undefined) = NaN.
    // Otherwise sending only `lat` reaches the range check and gets told its
    // longitude is out of range, when the actual problem is that it has none.
    const asCoord = (v) => (v === null || v === undefined ? null : Number(v));
    const lat = asCoord(body.lat);
    const lon = asCoord(body.lon);
    // Both or neither. Half a coordinate is not a location, and storing one
    // would put the place on the prime meridian.
    if ((lat === null) !== (lon === null)) {
      return { error: "Give both lat and lon, or neither" };
    }
    if (lat !== null) {
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { error: "lat is out of range" };
      if (!Number.isFinite(lon) || lon < -180 || lon > 180) return { error: "lon is out of range" };
    }
    data.lat = lat;
    data.lon = lon;
  }

  if (body.priority !== undefined) {
    const priority = parseInt(body.priority, 10);
    if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
      return { error: "priority must be between 1 and 5" };
    }
    data.priority = priority;
  }

  if (body.duration !== undefined) {
    if (body.duration === null) {
      data.duration = null;
    } else {
      const duration = parseInt(body.duration, 10);
      if (!Number.isInteger(duration) || duration < 1 || duration > MAX_DURATION_MIN) {
        return { error: `duration must be between 1 and ${MAX_DURATION_MIN} minutes` };
      }
      data.duration = duration;
    }
  }

  if (body.hours !== undefined) {
    const problem = checkHours(body.hours);
    if (problem) return { error: problem };
    data.hours = body.hours ?? null;
  }

  if (body.pinned_day !== undefined) {
    if (body.pinned_day === null || body.pinned_day === "") {
      data.pinned_day = null;
    } else {
      const day = String(body.pinned_day).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        return { error: "pinned_day must be a YYYY-MM-DD date" };
      }
      // Parsed as UTC midnight so the stored calendar day is the one that was
      // sent. `new Date("2026-09-14")` is already UTC, but the explicit suffix
      // stops anyone "fixing" it into a local-time parse later.
      data.pinned_day = new Date(`${day}T00:00:00Z`);
    }
  }

  // Validated as a pair, because the only invalid combination is a relationship
  // between them. The solver would treat contradictory bounds as an empty window
  // and drop the place with `time_conflict`, which is a correct answer to a
  // question nobody meant to ask — better to refuse the save.
  for (const field of ["arrive_after", "arrive_by"]) {
    if (body[field] === undefined) continue;
    if (body[field] === null || body[field] === "") {
      data[field] = null;
      continue;
    }
    const minutes = parseInt(body[field], 10);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MINUTES_IN_DAY) {
      return { error: `${field} must be a time of day` };
    }
    data[field] = minutes;
  }
  // Only catches a contradiction where both bounds are in the same request,
  // which is what the form sends. A PATCH that moves one against a stored value
  // gets through, and the solver reports it as `time_conflict` rather than
  // silently misplanning — checking properly would mean reading the row back
  // first, which is more machinery than this case is worth.
  const after = data.arrive_after ?? null;
  const by = data.arrive_by ?? null;
  if (after != null && by != null && after > by) {
    return { error: "That booking cannot start after it has to be over" };
  }

  if (body.outdoor !== undefined) data.outdoor = Boolean(body.outdoor);
  if (body.ignore_hours !== undefined) data.ignore_hours = Boolean(body.ignore_hours);
  if (body.address !== undefined) data.address = body.address?.trim() || null;
  if (body.url !== undefined) data.url = body.url?.trim() || null;
  if (body.note !== undefined) data.note = body.note?.trim() || null;
  if (body.sort_order !== undefined) data.sort_order = parseInt(body.sort_order, 10) || 0;

  return { data };
}

module.exports = { normalisePlaceInput, checkHours, KINDS, WEEKDAYS, MAX_DURATION_MIN };
