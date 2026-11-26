/**
 * The writes that carry an upgrade over: every loadout, and every trip still
 * ahead, that held the retired item gets its replacement instead (THO-1060).
 *
 * Before this, upgrading only retired the item and linked the replacement, and
 * travel-bag offered a per-loadout "⇄ swap" button for each place it was left
 * behind. Past trips are left alone on purpose: they record what was actually
 * carried, and their reviews are about the old item.
 *
 * Returned as Prisma operations, not run, so the route can put them in the
 * same transaction as the retirement itself: an upgrade that retired the item
 * but failed to swap it would leave loadouts packing gear you no longer own.
 *
 * Where the replacement is already in a loadout or on a trip, the old row is
 * dropped rather than repointed, which would collide with the loadout's
 * (loadout_id, gear_item_id) unique key and pack the trip's twice. The row
 * already there keeps its own bag and status.
 *
 * Bags too: if the retired item was a bag, what was packed in it moves to the
 * new bag.
 *
 * @param {object} prisma       client or transaction client
 * @param {string} userId
 * @param {number} oldId        the item being retired
 * @param {object} replacement  { id, name, category }
 * @param {Date}   now
 */
function upgradeCarryOverOps(prisma, { userId, oldId, replacement, now }) {
  const newId = replacement.id;
  const mine = { user_id: userId };
  // A trip starting today is left as it is: you are leaving with what you
  // packed. Undated trips are plans, so they count as ahead. start_date is a
  // calendar day stored as UTC midnight, so today's UTC midnight is the cut.
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const ahead = { ...mine, OR: [{ start_date: null }, { start_date: { gt: today } }] };

  return [
    prisma.loadoutEntry.deleteMany({
      where: { gear_item_id: oldId, loadout_rel: { ...mine, entries: { some: { gear_item_id: newId } } } },
    }),
    prisma.loadoutEntry.updateMany({
      where: { gear_item_id: oldId, loadout_rel: mine },
      data: { gear_item_id: newId },
    }),
    prisma.loadoutEntry.updateMany({
      where: { bag_id: oldId, loadout_rel: mine },
      data: { bag_id: newId },
    }),
    prisma.tripItem.deleteMany({
      where: { gear_item_id: oldId, trip_rel: { ...ahead, items: { some: { gear_item_id: newId } } } },
    }),
    // Name and category too: a trip row carries its own copy of them, taken
    // from the gear when it was packed, and the packing list shows that copy.
    prisma.tripItem.updateMany({
      where: { gear_item_id: oldId, trip_rel: ahead },
      data: { gear_item_id: newId, name: replacement.name, category: replacement.category ?? null },
    }),
    prisma.tripItem.updateMany({
      where: { bag_id: oldId, trip_rel: ahead },
      data: { bag_id: newId },
    }),
  ];
}

module.exports = { upgradeCarryOverOps };
