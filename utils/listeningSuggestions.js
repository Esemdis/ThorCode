/**
 * Which of the artists you listen to are worth suggesting, and whether a
 * connection can be asked for what you listen to at all.
 *
 * Split out of GET /bands/recommended so the matching can be tested without a
 * request, a token or a database — the route only fetches and calls these.
 */

const { canonicalBandName } = require('./lineupNames');

/**
 * Whether a stored grant includes a scope.
 *
 * `null` when the row does not say — connections whose token response carried
 * no scope string. Unknown is not "missing": the caller tries the read and lets
 * a 403 decide, rather than nagging everyone with an old row to reconnect.
 *
 * @param {string|null|undefined} granted - OAuth.scope, space-separated.
 * @param {string} scope
 * @returns {boolean|null}
 */
function grantsScope(granted, scope) {
  if (typeof granted !== 'string' || !granted.trim()) return null;
  return granted.split(/[\s,]+/).includes(scope);
}

/**
 * The listened-to artists that are not on the wishlist yet, each listed once.
 *
 * An artist is already on the wishlist when its Spotify id matches a band's
 * stored spotify_id, or failing that when its name does once both are
 * canonical ("Opeth" and "OPETH", "Mötley Crüe" and "Motley Crue"). Tidal ids
 * are never stored on a band, so a Tidal row can only match by name.
 *
 * Services are taken in the order given and the first one to name an artist
 * keeps it, so Spotify's row — which has an image and a link — wins over
 * Tidal's for the same act. Within a service the first mention wins too, which
 * keeps top artists ahead of the followed ones that repeat them.
 *
 * A name that canonicalises to nothing (punctuation only) is matched by id
 * alone: two such names would otherwise both be '' and the second, and every
 * wishlist band like it, would hide the first.
 *
 * @param {{ service: string, rows: { id: string, name: string }[] }[]} services
 * @param {{ name: string, spotify_id?: string|null }[]} wishlistBands
 * @returns {object[]} The kept rows, each with `service` added.
 */
function suggestFromListening(services, wishlistBands) {
  const ids = new Set();
  const names = new Set();
  for (const band of wishlistBands ?? []) {
    if (band?.spotify_id) ids.add(band.spotify_id);
    const key = canonicalBandName(band?.name);
    if (key) names.add(key);
  }

  const out = [];
  for (const { service, rows } of services ?? []) {
    for (const row of rows ?? []) {
      if (!row?.id || !row?.name) continue;
      const key = canonicalBandName(row.name);
      if (ids.has(row.id) || (key && names.has(key))) continue;
      // Grows as rows are kept, so a repeat in the same service or the next
      // one is dropped too.
      ids.add(row.id);
      if (key) names.add(key);
      out.push({ ...row, service });
    }
  }
  return out;
}

module.exports = { grantsScope, suggestFromListening };
