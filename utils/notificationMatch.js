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
// - city only             -> any band, that exact city
function subscriptionMatches(sub, concert, bandIds) {
  if (sub.band_id != null && sub.city_id != null) {
    return bandIds.includes(sub.band_id) && concert.city_id === sub.city_id;
  }
  if (sub.band_id != null) return bandIds.includes(sub.band_id);
  if (sub.city_id != null) return concert.city_id === sub.city_id;
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
 * @returns {Map<string, {email: string|null, concerts: Array}>}
 */
function matchesByUser(concerts, subscriptions) {
  // Keyed by concert id rather than pushed onto an array: watching a band and
  // watching the city it plays both match the same show, and the user should
  // be told about it once.
  const buckets = new Map();

  for (const concert of concerts) {
    const bandIds = (concert.bands ?? []).map((b) => b.band_rel.id);
    for (const sub of subscriptions) {
      if (!subscriptionMatches(sub, concert, bandIds)) continue;

      const uid = sub.user_rel?.id ?? sub.user_id;
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

module.exports = { subscriptionMatches, matchesByUser };
