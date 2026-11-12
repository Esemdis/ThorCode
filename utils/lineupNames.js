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

// Why these are hand-written scans and not regexes (THO-971): the patterns
// they replace were /\s*\d[\d.,]*\s*[KMB]?\s*followers?\s*$/i,
// /\s+official\s*$/i and /\s*\([^)]*\)\s*$/. Each leads with a run the engine
// retries from every start position, so a name with a long run of spaces,
// digits or "(" took time proportional to its length squared: 100,000 spaces
// took 31.6 s, on the one thread that answers every request. A name like that
// could be stored as a band, and these run over every stored band on each band
// add. Anchored at the end, a suffix can be found by reading backwards once.
// They cut exactly where the regexes did; lineupNames.test.js checks that
// against the old patterns.

// What \s matches is what trimEnd removes, so one test serves both.
const isSpace = (ch) => ch !== '' && ch.trim() === '';
const isDigit = (ch) => ch >= '0' && ch <= '9';

// Index just past the last non-space character at or before `end`.
function trimmedEnd(s, end) {
  let i = end;
  while (i > 0 && isSpace(s[i - 1])) i--;
  return i;
}

// Index of the first of the spaces that run back from `start`.
function spacesBefore(s, start) {
  let i = start;
  while (i > 0 && isSpace(s[i - 1])) i--;
  return i;
}

// Whether s[at..at+word.length) is `word`, ignoring ASCII case only. The
// regexes' /i (without /u) folded only ASCII here: toLowerCase would also
// turn the Kelvin sign into "k".
function asciiWordAt(s, at, word) {
  if (at < 0) return false;
  for (let i = 0; i < word.length; i++) {
    const code = s.charCodeAt(at + i);
    const lower = code >= 65 && code <= 90 ? code + 32 : code;
    if (lower !== word.charCodeAt(i)) return false;
  }
  return true;
}

// A follower count welded onto the end of a name: "Counterparts266K Followers",
// "Heavensgate5.31K Followers", "Someone1,204 followers". Returns where the
// suffix starts, or s.length when there is none.
function followerSuffixStart(s) {
  let i = trimmedEnd(s, s.length);
  if (asciiWordAt(s, i - 9, 'followers')) i -= 9;
  else if (asciiWordAt(s, i - 8, 'follower')) i -= 8;
  else return s.length;
  i = spacesBefore(s, i);
  if (i > 0 && 'KMBkmb'.includes(s[i - 1])) i = spacesBefore(s, i - 1);
  // The count is a run of digits, dots and commas that has to start with a
  // digit, so it is cut at the run's first digit: "x..5K" keeps "x..".
  let runStart = i;
  while (runStart > 0 && (isDigit(s[runStart - 1]) || s[runStart - 1] === '.' || s[runStart - 1] === ',')) runStart--;
  let firstDigit = runStart;
  while (firstDigit < i && !isDigit(s[firstDigit])) firstDigit++;
  if (firstDigit === i) return s.length;
  return spacesBefore(s, firstDigit);
}

// The Bandsintown profile suffix: "thrown official" is THROWN. It needs a space
// before it, so "thrownofficial" is left alone.
function profileSuffixStart(s) {
  const end = trimmedEnd(s, s.length);
  const at = end - 8;
  if (!asciiWordAt(s, at, 'official') || at === 0 || !isSpace(s[at - 1])) return s.length;
  return spacesBefore(s, at);
}

/**
 * Strip scraper and profile noise from one lineup name.
 *
 * @param {unknown} name
 * @returns {string} The cleaned name, or '' for anything that was not a string.
 */
function cleanLineupName(name) {
  if (typeof name !== 'string') return '';
  const withoutCount = name.slice(0, followerSuffixStart(name));
  const cleaned = withoutCount.slice(0, profileSuffixStart(withoutCount)).trim();
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
// Returns where it starts, or s.length when there is none. The parentheses
// hold no ")", so the suffix opens at the first "(" after the last ")" before
// the closing one: "A (b (c))" has no suffix to strip.
function countrySuffixStart(s) {
  const end = trimmedEnd(s, s.length);
  if (s[end - 1] !== ')') return s.length;
  const open = s.indexOf('(', s.lastIndexOf(')', end - 2) + 1);
  if (open === -1 || open >= end - 1) return s.length;
  return spacesBefore(s, open);
}

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
  const withoutSuffix = cleaned.slice(0, countrySuffixStart(cleaned)).trim() || cleaned;
  // Accents come off Latin letters (ö is o), and then any letter or digit in
  // any script is kept. It used to keep a-z and 0-9 only, which erased every
  // name not written in Latin — "Кино" and "陰陽座" were both '', so neither
  // could be matched or put on a bill, and every such artist shared one
  // Last.fm cache entry — and dropped letters like ø and æ that have no
  // accent to strip, so "Møl" was "ml". Recomposed before filtering so marks
  // that belong to a letter outside Latin (the dakuten in ガ) stay with it.
  return withoutSuffix
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

// How many distinct acts a stored lineup names. A column holding something
// other than a lineup — metadata is free-form text and older rows do — names
// none, rather than something to guess at.
function lineupSize(json) {
  if (!json) return 0;
  let parsed;
  try { parsed = JSON.parse(json); } catch { return 0; }
  if (!Array.isArray(parsed)) return 0;
  return new Set(parsed.map(canonicalBandName).filter(Boolean)).size;
}

/**
 * Whether a scraped lineup names more acts than the one already stored.
 *
 * Both of /bulk's merge paths see partial bills: Bandsintown files a festival's
 * acts stage by stage, so one scrape of a forty-act bill can name three, and
 * such a scrape must not overwrite the row. The unlinked names are the only
 * record of a support act nobody has ever wishlisted, and the bill they make is
 * what a follower's lineup alert is measured against.
 *
 * So the longer bill wins — counted on the names themselves, rather than on how
 * many of them matched a Band row, which is what the duplicate check used to
 * compare. An act joining a festival arrives without a Band row as often as
 * not, which left that count unchanged, so the row kept a lineup that never
 * mentioned the act and the alert had nothing to find.
 *
 * Counted canonically, so a source writing "Architects (UK)" where another
 * writes "Architects" is not a longer bill.
 *
 * @param {string|null|undefined} existingJson - the stored metadata column
 * @param {string|null|undefined} incomingJson - the scraped lineup
 * @returns {boolean}
 */
function lineupGrew(existingJson, incomingJson) {
  return lineupSize(incomingJson) > lineupSize(existingJson);
}

module.exports = { cleanLineupName, cleanLineupNames, cleanLineupJson, canonicalBandName, lineupGrew };
