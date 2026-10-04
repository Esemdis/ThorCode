// Country codes as people read them: a name, and a flag.
//
// Lifted out of ics.js when the weekly recap needed the same name for its
// Discord post. Mirrors concert-map's src/utils/countries.js, which is where
// the app itself draws these.

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/** Expand an ISO country code; anything Intl rejects is handed back untouched. */
function countryName(code) {
  if (!code) return code;
  try { return regionNames.of(code) ?? code; } catch { return code; }
}

/**
 * The flag emoji for an ISO 3166-1 alpha-2 code, built from regional
 * indicator symbols: 'DE' becomes U+1F1E9 U+1F1EA. Empty for anything that is
 * not two letters, which a concert's country sometimes is not.
 */
function countryFlag(code) {
  if (typeof code !== 'string' || !/^[A-Za-z]{2}$/.test(code)) return '';
  const OFFSET = 0x1f1e6 - 'A'.charCodeAt(0);
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => c.charCodeAt(0) + OFFSET));
}

module.exports = { countryName, countryFlag };
