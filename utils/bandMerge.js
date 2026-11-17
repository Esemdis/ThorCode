/**
 * Folding one Band row into another (THO-999).
 *
 * One artist under two names happens when a user adds a variant ("Opeth (SE)")
 * or photo tagging creates one. The survivor takes every row that pointed at
 * the source, then the source is deleted.
 *
 * Every band-level table has to be moved by hand, including the three that
 * cascade on delete (AttendanceMissedBand, ConcertDelivery,
 * NotificationSubscription). Skipping those would not fail anything: the
 * delete would quietly take "missed this act" marks and alert watches with it,
 * and losing the delivery ledger re-sends Discord alerts people already had.
 */

const { Prisma } = require('@prisma/client');

// The identities a band carries from outside. Two different non-null values
// usually mean two different artists, so the route asks before merging them;
// Spotify does sometimes list one artist twice, which is why it can be forced.
const BAND_MERGE_ID_FIELDS = ['MBID', 'spotify_id', 'ticketmaster_id'];

// Filled on the survivor from the source only where the survivor has nothing.
// The source URLs matter most: a survivor with no Songkick URL loses its scrape
// link with the source, and its concerts stop syncing.
const BAND_MERGE_FILL_FIELDS = [...BAND_MERGE_ID_FIELDS, 'songkick_url', 'bandsintown_url', 'setlist'];

// Warmest first. Two wishlist entries for one artist keep the warmer tier, so a
// merge never turns someone's LOVE into a FOLLOW.
const BAND_MERGE_TIER_ORDER = ['LOVE', 'LIKE', 'FOLLOW'];

function bandMergeConflicts(source, target) {
  return BAND_MERGE_ID_FIELDS
    .filter((f) => source[f] != null && target[f] != null && source[f] !== target[f])
    .map((f) => ({ field: f, source: source[f], target: target[f] }));
}

/** The fields to write onto the survivor: its gaps, and the earlier created_at. */
function bandMergeGaps(source, target) {
  const gaps = {};
  for (const f of BAND_MERGE_FILL_FIELDS) {
    if (target[f] == null && source[f] != null) gaps[f] = source[f];
  }
  // The setlist's timestamp says how stale it is, so it travels with it.
  if ('setlist' in gaps && source.setlist_updated_at != null) gaps.setlist_updated_at = source.setlist_updated_at;
  if (source.created_at != null && (target.created_at == null || source.created_at < target.created_at)) {
    gaps.created_at = source.created_at;
  }
  return gaps;
}

function strongerBandTier(a, b) {
  return BAND_MERGE_TIER_ORDER.indexOf(a) <= BAND_MERGE_TIER_ORDER.indexOf(b) ? a : b;
}

/**
 * Run inside a transaction. Writes nothing unless it answers 'merged'.
 *
 * @returns {Promise<
 *   | { status: 'missing', bandId: number }
 *   | { status: 'conflict', conflicts: Array<{ field: string, source: string, target: string }> }
 *   | { status: 'merged', survivor: { id: number, name: string }, moved: object, dropped: object,
 *       filled: string[], overridden: object[], retagPaths: string[] }>}
 */
async function mergeBands(tx, sourceId, targetId, { force = false } = {}) {
  // FOR UPDATE on both rows first. A row that references a band takes a KEY
  // SHARE lock on it, so a sync linking the source to a show waits for this
  // transaction rather than slipping a link in after the move and failing the
  // delete. In id order, so two crossed merges cannot deadlock.
  const [lo, hi] = sourceId < targetId ? [sourceId, targetId] : [targetId, sourceId];
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Band" WHERE id IN (${lo}, ${hi}) ORDER BY id FOR UPDATE`);

  const source = await tx.band.findUnique({ where: { id: sourceId } });
  if (!source) return { status: 'missing', bandId: sourceId };
  const target = await tx.band.findUnique({ where: { id: targetId } });
  if (!target) return { status: 'missing', bandId: targetId };

  const conflicts = bandMergeConflicts(source, target);
  if (conflicts.length && !force) return { status: 'conflict', conflicts };

  const moved = {};
  const dropped = {};

  // Shows. (concert, band) is unique, so a show both names were on keeps the
  // survivor's link. Two things on the source's link are worth keeping: its
  // per-show setlist, and a pending alert, or a festival act the sync linked
  // under the other name is never announced.
  const linkFields = { id: true, concert: true, setlist: true, notify_pending: true };
  const ourLinks = new Map((await tx.concertBandReference.findMany({
    where: { band: targetId }, select: linkFields,
  })).map((l) => [l.concert, l]));
  const linkTwins = (await tx.concertBandReference.findMany({
    where: { band: sourceId }, select: linkFields,
  })).filter((l) => ourLinks.has(l.concert));
  for (const twin of linkTwins) {
    const ours = ourLinks.get(twin.concert);
    const data = {};
    if (ours.setlist == null && twin.setlist != null) data.setlist = twin.setlist;
    if (twin.notify_pending && !ours.notify_pending) data.notify_pending = true;
    if (Object.keys(data).length) {
      await tx.concertBandReference.update({ where: { id: ours.id }, data });
    }
  }
  if (linkTwins.length) await tx.concertBandReference.deleteMany({ where: { id: { in: linkTwins.map((l) => l.id) } } });
  dropped.concerts = linkTwins.length;
  moved.concerts = (await tx.concertBandReference.updateMany({ where: { band: sourceId }, data: { band: targetId } })).count;

  // Wishlists: (band_id, wishlist_id) is unique.
  const ourRefs = new Map((await tx.wishlistBandReference.findMany({
    where: { band_id: targetId }, select: { id: true, wishlist_id: true, tier: true },
  })).map((r) => [r.wishlist_id, r]));
  const refTwins = (await tx.wishlistBandReference.findMany({
    where: { band_id: sourceId }, select: { id: true, wishlist_id: true, tier: true },
  })).filter((r) => ourRefs.has(r.wishlist_id));
  for (const twin of refTwins) {
    const ours = ourRefs.get(twin.wishlist_id);
    const tier = strongerBandTier(ours.tier, twin.tier);
    if (tier !== ours.tier) await tx.wishlistBandReference.update({ where: { id: ours.id }, data: { tier } });
  }
  if (refTwins.length) await tx.wishlistBandReference.deleteMany({ where: { id: { in: refTwins.map((r) => r.id) } } });
  dropped.wishlists = refTwins.length;
  moved.wishlists = (await tx.wishlistBandReference.updateMany({ where: { band_id: sourceId }, data: { band_id: targetId } })).count;

  // "Missed this act": the key is (attendance_id, band_id).
  const ourMissed = new Set((await tx.attendanceMissedBand.findMany({
    where: { band_id: targetId }, select: { attendance_id: true },
  })).map((m) => m.attendance_id));
  const missedTwins = (await tx.attendanceMissedBand.findMany({
    where: { band_id: sourceId }, select: { attendance_id: true },
  })).filter((m) => ourMissed.has(m.attendance_id)).map((m) => m.attendance_id);
  if (missedTwins.length) {
    await tx.attendanceMissedBand.deleteMany({ where: { band_id: sourceId, attendance_id: { in: missedTwins } } });
  }
  dropped.missed = missedTwins.length;
  moved.missed = (await tx.attendanceMissedBand.updateMany({ where: { band_id: sourceId }, data: { band_id: targetId } })).count;

  // The alert ledger: the key is (concert_id, wishlist_id, band_id). Either
  // row says the post went out, so the survivor's is enough.
  const deliveryKey = (d) => `${d.concert_id}|${d.wishlist_id}`;
  const ourDeliveries = new Set((await tx.concertDelivery.findMany({
    where: { band_id: targetId }, select: { concert_id: true, wishlist_id: true },
  })).map(deliveryKey));
  const deliveryTwins = (await tx.concertDelivery.findMany({
    where: { band_id: sourceId }, select: { concert_id: true, wishlist_id: true },
  })).filter((d) => ourDeliveries.has(deliveryKey(d)));
  if (deliveryTwins.length) {
    await tx.concertDelivery.deleteMany({
      where: { band_id: sourceId, OR: deliveryTwins.map(({ concert_id, wishlist_id }) => ({ concert_id, wishlist_id })) },
    });
  }
  dropped.deliveries = deliveryTwins.length;
  moved.deliveries = (await tx.concertDelivery.updateMany({ where: { band_id: sourceId }, data: { band_id: targetId } })).count;

  // Alert watches have no unique key, but a user watching both names in one
  // city would get every alert twice, so the same watch is kept once.
  const watchKey = (s) => [s.user_id, s.city_id, s.tour_query, s.venue_query].join('|');
  const watchFields = { id: true, user_id: true, city_id: true, tour_query: true, venue_query: true };
  const ourWatches = new Set((await tx.notificationSubscription.findMany({
    where: { band_id: targetId }, select: watchFields,
  })).map(watchKey));
  const watchTwins = (await tx.notificationSubscription.findMany({
    where: { band_id: sourceId }, select: watchFields,
  })).filter((s) => ourWatches.has(watchKey(s))).map((s) => s.id);
  if (watchTwins.length) await tx.notificationSubscription.deleteMany({ where: { id: { in: watchTwins } } });
  dropped.subscriptions = watchTwins.length;
  moved.subscriptions = (await tx.notificationSubscription.updateMany({ where: { band_id: sourceId }, data: { band_id: targetId } })).count;

  // Photographs and clips. The song stays: it is the same artist's song.
  const tagged = await tx.concertMedia.findMany({ where: { band_id: sourceId }, select: { rel_path: true } });
  moved.media = (await tx.concertMedia.updateMany({ where: { band_id: sourceId }, data: { band_id: targetId } })).count;

  // The source goes before the survivor is filled: MBID, spotify_id and
  // ticketmaster_id are unique, and the survivor cannot take one while the
  // source still holds it.
  await tx.band.delete({ where: { id: sourceId } });
  const gaps = bandMergeGaps(source, target);
  if (Object.keys(gaps).length) await tx.band.update({ where: { id: targetId }, data: gaps });

  return {
    status: 'merged',
    survivor: { id: target.id, name: target.name },
    moved,
    dropped,
    filled: Object.keys(gaps),
    overridden: conflicts,
    retagPaths: tagged.map((m) => m.rel_path),
  };
}

module.exports = { bandMergeConflicts, bandMergeGaps, strongerBandTier, mergeBands };
