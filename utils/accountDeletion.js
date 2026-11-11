/**
 * Deleting an account and everything it owns (THO-810).
 *
 * Most of what points at a user has no `onDelete: Cascade`: the wishlist and
 * everything under it, OAuth grants, and all of Travel Bag (trips, templates,
 * gear, loadouts, reviews, the travel wishlist). Postgres refuses to delete
 * the user while any of it exists. Rather than add cascades in a migration,
 * the rows go in an explicit order inside one transaction. A cascade would
 * also have reached ConcertMedia, whose Restrict is the guarantee that no
 * database delete destroys the only copy of a photograph (utils/mediaDetach.js).
 *
 * So the photos and videos go first, the way DELETE /media does it: file,
 * then sidecar, then row (utils/mediaRemove.js). Only once nothing of the
 * user is left on disk does the transaction run. A failure on disk stops
 * before any row besides those files' own has gone, and a retry finishes.
 */

const { rm, unlink } = require('node:fs/promises');
const { removeMediaFiles } = require('./mediaRemove');
const { removeClip } = require('./mediaClips');
const {
  resolveArchivePath, slugSegment, thumbPath,
} = require('./mediaPaths');
const { displayPath } = require('./mediaThumbs');

// The user's rows, in the order they can be deleted. Each entry's model is
// referenced by none of the entries after it without a cascade. Whatever
// cascades from the user itself (venue reviews, concert follows, album share
// links, notification subscriptions, email verifications, password resets)
// goes with `user.delete` at the end and is not listed.
//
// accountDeletion.test.js reads prisma/schema.prisma and fails if a model
// that blocks one of these deletes is missing, or listed after the model it
// blocks. A new table pointing at User without a cascade has to be added here.
const ACCOUNT_DELETION_ORDER = [
  // Attendances own the media, which is gone by now, and cascade to their
  // missed-band notes. ConcertDelivery cascades from the wishlist.
  { model: 'concertAttendance', where: (userId) => ({ wishlist_rel: { user_id: userId } }) },
  { model: 'wishlistBandReference', where: (userId) => ({ wishlist_rel: { user_id: userId } }) },
  { model: 'activityLog', where: (userId) => ({ wishlist_rel: { user_id: userId } }) },
  { model: 'wishlist', where: (userId) => ({ user_id: userId }) },
  { model: 'oAuth', where: (userId) => ({ user: userId }) },
  // Reviews by user, before trips: a trip's own reviews would cascade with it,
  // but a review is also tied to its author, and that tie has no cascade.
  { model: 'itemReview', where: (userId) => ({ user_id: userId }) },
  { model: 'tripReview', where: (userId) => ({ user_id: userId }) },
  // Cascades to the trip's items and todos.
  { model: 'trip', where: (userId) => ({ user_id: userId }) },
  // Cascades to the loadout's entries.
  { model: 'loadout', where: (userId) => ({ user_id: userId }) },
  // Cascades to the template's items.
  { model: 'template', where: (userId) => ({ user_id: userId }) },
  // After loadouts and trips; what still points at a gear item cascades or is
  // set to null.
  { model: 'gearItem', where: (userId) => ({ user_id: userId }) },
  { model: 'travelWishlistItem', where: (userId) => ({ user_id: userId }) },
];

// Handled before the transaction, on disk first (see removeAccountMedia).
const DELETED_BEFORE_TRANSACTION = ['concertMedia'];

/**
 * Why this account may not be deleted, or null when it may.
 *
 * The SYSTEM user is what python-crohn signs in as: deleting it would stop
 * every sync until someone minted a new token by hand. The last admin is the
 * only account that can run the admin panel, and nothing in the app can make
 * another one.
 *
 * @param {{role: string}} user
 * @param {number} adminCount - every ADMIN account, this one included
 * @returns {{status: number, message: string} | null}
 */
function accountDeletionRefusal(user, adminCount) {
  if (user.role === 'SYSTEM') {
    return { status: 403, message: 'The service account cannot be deleted' };
  }
  if (user.role === 'ADMIN' && adminCount <= 1) {
    return { status: 409, message: 'You are the only admin. Make someone else an admin before deleting this account.' };
  }
  return null;
}

/**
 * Every row of the user's, as one transaction's worth of operations, ending
 * with the user itself.
 *
 * @param {object} prisma
 * @param {string} userId
 */
function accountDeletionOperations(prisma, userId) {
  return [
    ...ACCOUNT_DELETION_ORDER.map(({ model, where }) => prisma[model].deleteMany({ where: where(userId) })),
    prisma.user.delete({ where: { id: userId } }),
  ];
}

/**
 * The user's own folder in the archive: '<archive>/<user>'. Every show folder
 * of theirs is inside it, and so is their `_detached` folder, which holds
 * shows whose concert was deleted and which no row points at any more.
 *
 * Refuses an id that is not one. slugSegment turns '' into '-', a folder that
 * is nobody's, and a mistake here removes a folder with everything in it.
 */
function userArchiveDir(userId) {
  if (typeof userId !== 'string' || !userId.trim()) {
    throw new Error(`Refusing to remove an archive folder for user ${JSON.stringify(userId)}`);
  }
  return resolveArchivePath(slugSegment(userId));
}

/**
 * Take the user's photos and videos out of the archive, and their rows out of
 * the index.
 *
 * Every file a row names goes through removeMediaFiles, so a video takes its
 * poster, rendition and failure marker with it, and the sidecars are kept true
 * while it works. Then the user's whole folder goes: that is what also takes
 * `_detached`, the sidecars and any file the index never knew about.
 *
 * @param {object} prisma
 * @param {string} userId
 * @param {{ remove?: typeof removeMediaFiles, removeDir?: (dir: string) => Promise<void> }} [deps]
 * @returns {Promise<{ ok: boolean, sha256s: string[] }>} ok false when
 *   something is still on disk, in which case nothing else may be deleted;
 *   sha256s are the removed files' checksums, for removeDerivedCopies
 */
async function removeAccountMedia(prisma, userId, {
  remove = removeMediaFiles,
  removeDir = (dir) => rm(dir, { recursive: true, force: true }),
} = {}) {
  const rows = await prisma.concertMedia.findMany({
    where: { attendance_rel: { wishlist_rel: { user_id: userId } } },
    select: { id: true, rel_path: true, filename: true, kind: true, sha256: true },
  });

  if (rows.length) {
    // Read before the rows go, as DELETE /media does: the cascade takes the
    // links with it, and a moment not yet cut would sit in cache/clips.
    const clipLinks = await prisma.mediaShareLink.findMany({
      where: { media_id: { in: rows.map((r) => r.id) } },
      select: { id: true, media_id: true },
    });

    const { removed, failed } = await remove(rows);
    // Only the rows whose files are gone; the others still describe files
    // that are there, and a retry needs them to find those.
    if (removed.length) await prisma.concertMedia.deleteMany({ where: { id: { in: removed } } });
    const removedSet = new Set(removed);
    for (const link of clipLinks.filter((l) => removedSet.has(l.media_id))) await removeClip(link.id);
    if (failed.length) return { ok: false, sha256s: [] };
  }

  // A user who never uploaded has nothing on disk, and a server without
  // MEDIA_ROOT has no archive to look in.
  if (!rows.length && !process.env.MEDIA_ROOT) return { ok: true, sha256s: [] };
  try {
    await removeDir(userArchiveDir(userId));
  } catch (err) {
    console.error(`[account] could not remove the archive folder of ${userId}`, err);
    return { ok: false, sha256s: [] };
  }
  return { ok: true, sha256s: [...new Set(rows.map((r) => r.sha256))] };
}

/**
 * Remove the cached thumbnails and display copies of these files, unless
 * another row still has the same bytes (they are keyed by checksum, so two
 * uploads of one photograph share them).
 *
 * The cache is derived and may be deleted at any time, so a failure here is
 * logged and nothing more: the account is already gone.
 */
async function removeDerivedCopies(prisma, sha256s) {
  if (!sha256s.length) return;
  try {
    const kept = new Set((await prisma.concertMedia.findMany({
      where: { sha256: { in: sha256s } },
      select: { sha256: true },
    })).map((r) => r.sha256));
    for (const sha of sha256s.filter((s) => !kept.has(s))) {
      for (const file of [thumbPath(sha), displayPath(sha)]) {
        await unlink(file).catch((err) => { if (err.code !== 'ENOENT') throw err; });
      }
    }
  } catch (err) {
    console.error('[account] could not remove cached copies of a deleted account\'s media', err);
  }
}

module.exports = {
  ACCOUNT_DELETION_ORDER,
  DELETED_BEFORE_TRANSACTION,
  accountDeletionRefusal,
  accountDeletionOperations,
  userArchiveDir,
  removeAccountMedia,
  removeDerivedCopies,
};
