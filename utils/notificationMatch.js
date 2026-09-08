/**
 * Who wants to hear about a concert.
 *
 * Lifted out of concertNotifyDigest.js when the Discord path started matching
 * subscriptions too. Both callers have to agree on what "matches" means — the
 * daily email digest and the instant Discord post are the same promise made to
 * the user twice, and two copies of this rule would drift the first time one
 * side gained a subscription kind.
 */

// Which subscription kinds match a given concert:
// - band + city both set  -> that band, playing that exact city
// - band only             -> that band, any city
// - city only             -> a band the subscriber follows, playing that city
//
// `followedBandIds` is the subscriber's own wishlist, as a Set of band ids, and
// only the city-only kind consults it. Naming a band in the watch is already
// the request, so a band or band+city watch fires whether or not the band is
// also on the wishlist.
//
// The city-only kind used to mean "any band at all", which read the same as
// "my bands" only while one account existed. Band rows are global and the
// scraper syncs every one of them (GET /data/concerts/bands is unfiltered), so
// a second user signing up turned every city watch into a feed of other
// people's artists.
function subscriptionMatches(sub, concert, bandIds, followedBandIds) {
  if (sub.band_id != null && sub.city_id != null) {
    return bandIds.includes(sub.band_id) && concert.city_id === sub.city_id;
  }
  if (sub.band_id != null) return bandIds.includes(sub.band_id);
  if (sub.city_id != null) {
    if (concert.city_id !== sub.city_id) return false;
    // No follow set means no match, rather than the old wildcard: a caller that
    // forgets to pass one should go quiet, not silently reopen the leak.
    if (!followedBandIds) return false;
    // Any one band on the bill is enough — support slots and festivals put
    // several on a single concert row.
    return bandIds.some((id) => followedBandIds.has(id));
  }
  // Both null. The column pair allows it even though the POST route rejects it,
  // and a row written by hand or by a future backfill must not become a
  // wildcard that forwards the whole database to whoever owns it.
  return false;
}

/**
 * Groups concerts by the user whose subscriptions matched them.
 *
 * @param {Array} concerts - rows selecting at least id, city_id and
 *   bands.band_rel.id
 * @param {Array} subscriptions - NotificationSubscription rows, each including
 *   user_rel with id and email
 * @param {Map<string, Set<number>>} followedByUser - user id -> the band ids on
 *   that user's wishlist. Scopes city-only watches; see subscriptionMatches.
 * @returns {Map<string, {email: string|null, concerts: Array}>}
 */
function matchesByUser(concerts, subscriptions, followedByUser = new Map()) {
  // Keyed by concert id rather than pushed onto an array: watching a band and
  // watching the city it plays both match the same show, and the user should
  // be told about it once.
  const buckets = new Map();

  for (const concert of concerts) {
    const bandIds = (concert.bands ?? []).map((b) => b.band_rel.id);
    for (const sub of subscriptions) {
      const uid = sub.user_rel?.id ?? sub.user_id;
      if (!subscriptionMatches(sub, concert, bandIds, followedByUser.get(uid))) continue;

      if (!buckets.has(uid)) {
        buckets.set(uid, { email: sub.user_rel?.email ?? null, items: new Map() });
      }
      const bucket = buckets.get(uid);
      if (!bucket.items.has(concert.id)) bucket.items.set(concert.id, concert);
    }
  }

  return new Map(
    [...buckets].map(([uid, { email, items }]) => [uid, { email, concerts: [...items.values()] }]),
  );
}

/**
 * Builds the follow map matchesByUser and subscriptionMatches expect.
 *
 * Wishlist is one-per-user (`user_id @unique`), so this is a straight fold, but
 * both notification paths need the identical shape and neither should have to
 * remember that `bands` holds WishlistBandReference rows rather than bands.
 *
 * @param {Array} wishlists - rows selecting user_id and bands.band_id
 * @returns {Map<string, Set<number>>}
 */
function followedBandsByUser(wishlists) {
  const byUser = new Map();
  for (const wishlist of wishlists) {
    const ids = (wishlist.bands ?? []).map((b) => b.band_id ?? b.band_rel?.id).filter((id) => id != null);
    const existing = byUser.get(wishlist.user_id);
    if (existing) ids.forEach((id) => existing.add(id));
    else byUser.set(wishlist.user_id, new Set(ids));
  }
  return byUser;
}

module.exports = { subscriptionMatches, matchesByUser, followedBandsByUser };
