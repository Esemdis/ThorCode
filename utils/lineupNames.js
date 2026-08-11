// Lineup names reach us as raw text scraped off a Bandsintown event page, and
// every artist link wraps the name and the follower count with nothing between
// them: "Counterparts266K Followers". Bandsintown profile names carry a second
// quirk no other source has — an "official" suffix, so THROWN is "thrown
// official" there and appeared twice on its own bill at Fållan: once as the
// linked band, once as a support act nobody could match it to.
//
// Both forms are compared against band.name in two places — the exact match in
// POST /bulk and the 0.75 similarity in POST /:id/enrich-lineup — and both land
// under the threshold, so a wishlist band on the bill is stored as a loose
// string and never linked to the concert. "Counterparts266K Followers" scores
// 0.63 against "Counterparts"; cleaned, it scores 1.
//
// Clean at the write boundary rather than at render, so what is stored is what
// matches.

// A follower count welded onto the end of a name: "Counterparts266K Followers",
// "Heavensgate5.31K Followers", "Someone1,204 followers".
const FOLLOWER_SUFFIX = /\s*\d[\d.,]*\s*[KMB]?\s*followers?\s*$/i;

// The Bandsintown profile suffix: "thrown official" is THROWN.
const PROFILE_SUFFIX = /\s+official\s*$/i;

/**
 * Strip scraper and profile noise from one lineup name.
 *
 * @param {unknown} name
 * @returns {string} The cleaned name, or '' for anything that was not a string.
 */
function cleanLineupName(name) {
  if (typeof name !== 'string') return '';
  const cleaned = name.replace(FOLLOWER_SUFFIX, '').replace(PROFILE_SUFFIX, '').trim();
  // Never clean a name out of existence — a band actually called "Official" is
  // likelier than an entry that was nothing but suffix.
  return cleaned || name.trim();
}

/**
 * Clean a whole lineup, dropping non-strings and blanks.
 *
 * Cleaning can make two entries identical ("Counterparts" alongside
 * "Counterparts266K Followers"), so the result is de-duplicated
 * case-insensitively, keeping the first spelling seen.
 *
 * @param {unknown} names
 * @returns {string[]}
 */
function cleanLineupNames(names) {
  if (!Array.isArray(names)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    const name = cleanLineupName(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Clean a concert's `metadata` column, which holds the lineup as a JSON array
 * of strings.
 *
 * Anything that is not a JSON array of names is returned untouched: metadata is
 * a free-form text column and older rows may hold something else, which is
 * worth keeping over discarding.
 *
 * @param {string|null|undefined} json
 * @returns {string|null} JSON for the cleaned lineup, or null if it is empty.
 */
function cleanLineupJson(json) {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return json;
    const cleaned = cleanLineupNames(parsed);
    return cleaned.length > 0 ? JSON.stringify(cleaned) : null;
  } catch {
    return json;
  }
}

// A trailing disambiguator: "Architects (UK)", "Polaris (AUS)", "Psychonaut (be)".
// Sources disagree about whether to include it, and it is the only difference
// that regularly separates a lineup name from the band row it belongs to.
const COUNTRY_SUFFIX = /\s*\([^)]*\)\s*$/;

/**
 * Reduce a band or lineup name to the form used to decide whether two names are
 * the same band: cleaned of scraper noise, stripped of a trailing
 * disambiguator, unaccented, and down to letters and digits.
 *
 * This replaced a 0.75 similarity score, which read "Alestorm" as "Halestorm"
 * at 0.93 and "Nothing" as "Nothing More" at 0.75. A missed link shows up as a
 * band name in grey on the popup and can be added by hand; a wrong one puts a
 * show on your map that the band is not playing, and nothing in the UI says
 * where it came from.
 *
 * @param {unknown} name
 * @returns {string} '' when there is nothing left to compare.
 */
function canonicalBandName(name) {
  const cleaned = cleanLineupName(name);
  if (!cleaned) return '';
  const withoutSuffix = cleaned.replace(COUNTRY_SUFFIX, '').trim() || cleaned;
  return withoutSuffix
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

module.exports = { cleanLineupName, cleanLineupNames, cleanLineupJson, canonicalBandName };
