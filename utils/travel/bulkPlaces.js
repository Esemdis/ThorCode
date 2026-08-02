/**
 * Turn a pasted list into places.
 *
 * The planner is built around thirty places competing for thirty-two slots, and
 * until this existed the only way to get thirty places in was thirty passes
 * through a form, each one blocking about a second on a rate-limited geocoder.
 * The data entry cost more than the planning saved.
 *
 * So: one place per line, and be forgiving about what a line looks like. People
 * paste from notes apps, from a chat message, from a list of map links they sent
 * themselves — all of which arrive with bullets, numbering and stray whitespace.
 * Rejecting those would move the tedium rather than remove it.
 *
 * Pure: text in, rows out. The route does the writing and the geocoding.
 */

// Anywhere in the line, not anchored: "Louvre https://maps.app.goo.gl/x" is a
// perfectly ordinary thing to paste and both halves are worth keeping.
const URL_RE = /https?:\/\/\S+/i;

// "- ", "* ", "• ", "1. ", "2) " — every list marker a notes app might leave on.
const LIST_MARKER_RE = /^\s*(?:[-*•‣·]|\d+[.)])\s+/;

// Same ceiling as MAX_PLACES in planRequest.js. A paste that would take the trip
// past what the solver will accept should say so now, not at planning time.
const MAX_PLACES = 80;

// Matches the name column, which is @db.VarChar(200).
const MAX_NAME = 200;

/**
 * The place name out of a map URL, if it carries one.
 *
 * Google puts it in the path — /maps/place/Louvre+Museum/@48.86,2.33 — which
 * means a list of pasted links can arrive with real names instead of thirty rows
 * called "maps.app.goo.gl". Short links have no name in them and fall back to
 * the host, which at least reads as a link rather than as a mystery.
 */
function nameFromUrl(url) {
  const inPath = /\/place\/([^/@?#]+)/.exec(url);
  if (inPath) {
    const decoded = safeDecode(inPath[1]).replace(/\+/g, " ").trim();
    if (decoded) return decoded.slice(0, MAX_NAME);
  }
  const host = /^https?:\/\/([^/?#]+)/i.exec(url);
  return host ? host[1] : null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    // A lone % in a URL is not a reason to lose the whole line.
    return value;
  }
}

/** Case- and space-insensitive, for deciding two lines are the same place. */
const key = (name) => String(name || "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * @param {string} text     what was pasted
 * @param {object} options  existing: names already on the trip; max: room left
 * @returns {{places: Array, skipped: Array}} rows to create, and what was
 *          dropped with the reason — both are shown, because a paste that
 *          silently creates 28 of 30 rows is worse than one that explains.
 */
function parseBulkPlaces(text, { existing = [], max = MAX_PLACES } = {}) {
  const seen = new Set(existing.map(key).filter(Boolean));
  const places = [];
  const skipped = [];

  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(LIST_MARKER_RE, "").trim();
    if (!line) continue;

    const match = URL_RE.exec(line);
    const url = match ? match[0] : null;
    // Whatever is left once the link is taken out. Trailing punctuation goes
    // too, because "Louvre — https://..." leaves a dangling dash.
    const rest = (match ? line.replace(match[0], "") : line)
      .replace(/[\s,;|—–-]+$/, "")
      .replace(/^[\s,;|—–-]+/, "")
      .trim();

    const name = (rest || (url ? nameFromUrl(url) : "") || "").slice(0, MAX_NAME);
    if (!name) {
      skipped.push({ line, reason: "no_name" });
      continue;
    }

    if (seen.has(key(name))) {
      // Pasting the same list twice is a normal accident and should be a no-op,
      // not sixty rows.
      skipped.push({ line, reason: "duplicate" });
      continue;
    }
    if (places.length >= max) {
      skipped.push({ line, reason: "too_many" });
      continue;
    }

    seen.add(key(name));
    // `address` deliberately stays null. The name is what gets searched, and
    // storing the same string in two columns would make a later edit ambiguous
    // about which one the user meant.
    places.push({ name, url });
  }

  return { places, skipped };
}

module.exports = { parseBulkPlaces, nameFromUrl, MAX_PLACES, MAX_NAME };
