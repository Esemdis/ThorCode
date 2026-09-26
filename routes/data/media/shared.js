/**
 * What more than one of the media routers needs: the caller's attendance and
 * the shows a file could move to, the per-show locks, and the few small
 * conversions every route that files something makes the same way.
 */
const prisma = require('../../../prisma/client');
const { notFound, forbidden } = require('../../../utils/apiResponse');
const { acquire } = require('../../../utils/serialQueue');

// Date-only, sliced rather than parsed. concert_date already carries a UTC
// instant, and toISOString always renders in UTC regardless of the server's
// local time zone, so this reads the same calendar day no matter where the
// container runs. Reformatting through a local-time path (toLocaleDateString,
// or parsing a bare "YYYY-MM-DD" and printing it back) is what slides the day
// backwards for anyone west of UTC, and would file a show under the wrong
// folder.
const dateOnly = (d) => new Date(d).toISOString().slice(0, 10);

const headlinerOf = (concert) => concert.bands?.[0]?.band_rel?.name ?? '';

// width/height/duration_ms, and a moment's start and end, are 32-bit Postgres
// Int columns.
const INT32_MAX = 2147483647;

/**
 * What a new sidecar is seeded with when a show folder has none yet: which
 * concert and whose, and the facts of the night a person reading the folder by
 * hand would want. The upload and the tag sweep both write one, and must agree.
 */
function sidecarSeed(concert, userId) {
  return {
    concertId: concert.id,
    userId,
    concert: {
      date: dateOnly(concert.concert_date), venue: concert.venue,
      city: concert.city, country: concert.country,
    },
  };
}

/**
 * The caller's own attendance, with everything the archive path needs.
 * Returns null rather than throwing so each route decides the status code.
 */
async function ownAttendance(attendanceId, userId) {
  const row = await prisma.concertAttendance.findUnique({
    where: { id: attendanceId },
    include: {
      wishlist_rel: { select: { user_id: true } },
      concert_rel: {
        select: {
          id: true, concert_date: true, venue: true, city: true, country: true,
          // The scraped lineup. Support acts nobody has ever wishlisted live
          // only here, as plain strings, and on a festival that is most of
          // the bill.
          metadata: true,
          // Both setlists: `setlist` is what this band played at this show,
          // `band_rel.setlist` the most recent one we have for them anywhere.
          // The upload route shares this helper and needs neither, but a
          // handful of song lists alongside a multi-megabyte upload is not a
          // cost worth a second query to avoid.
          bands: {
            select: {
              band: true,
              setlist: true,
              band_rel: { select: { id: true, name: true, setlist: true } },
            },
          },
        },
      },
    },
  });
  if (!row) return { row: null, owned: false };
  return { row, owned: row.wishlist_rel.user_id === userId };
}

/**
 * Every show of the caller's whose bill has this band: the candidates
 * festivalSibling chooses from when a file's own show does not have it. The
 * tag sweep moves a file into one of these, and the upload route files into
 * one, by the same rule and from the same list.
 */
function billCandidates(userId, bandId) {
  return prisma.concertAttendance.findMany({
    where: {
      wishlist_rel: { user_id: userId },
      concert_rel: { bands: { some: { band: bandId } } },
    },
    select: {
      id: true,
      concert_rel: {
        select: {
          id: true, concert_date: true, venue: true, city: true, country: true,
          bands: { select: { band_rel: { select: { id: true, name: true } } } },
        },
      },
    },
  });
}

// Who a media row belongs to, which is all the deletes, the share routes and
// the byte routes need to know besides the row itself.
const withOwner = { attendance_rel: { include: { wishlist_rel: { select: { user_id: true } } } } };

/**
 * The refusals every write over a list of files shares, answered here.
 * Returns the response it sent, or null when every id was found and every file
 * is the caller's.
 *
 * Checked for every row before anything is written. A list containing one row
 * belonging to someone else must change nothing at all, rather than updating
 * the caller's rows and failing partway.
 */
function refuseRows(res, rows, ids, userId, missing = 'Some media not found') {
  if (rows.length !== ids.length) return notFound(res, missing);
  if (rows.some((r) => r.attendance_rel.wishlist_rel.user_id !== userId)) return forbidden(res, 'Forbidden');
  return null;
}

// How many times a request takes its locks again when a file moves between the
// read that chose them and the read made under them. Two requests racing
// settle in one retry; missing three times running means the same files are
// being changed as fast as they can be locked, which is better answered than
// chased.
const LOCK_ATTEMPTS = 3;

/**
 * Hold the upload route's lock on every show some work touches, and read the
 * rows the work is about while holding them.
 *
 * Which shows to lock comes from where the rows are, and where the rows are is
 * exactly what a concurrent tag changes. So they are read again once the locks
 * are held, and that read is the one the work must use: a request that waited
 * on another's locks and then went on with what it had read before waiting
 * would undo the other's move, or write a sidecar in a folder a file had just
 * left. If a row now lives in a show outside the set, every lock is let go and
 * the set is chosen again from where the rows are now.
 *
 * Taken in ascending id order, so two requests over overlapping shows cannot
 * each hold one and wait on the other.
 *
 * @param {object[]} rows - as first read, each with attendance_id
 * @param {() => Promise<object[]>} read - reads the same rows afresh
 * @param {(rows: object[]) => number[]} showsFor - every attendance to lock for these rows
 * @returns {Promise<{rows: object[], release: () => void}|null>} null when the
 *   rows would not hold still; otherwise the caller MUST release, in a finally
 */
async function lockShows(rows, read, showsFor) {
  let seen = rows;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    const ids = [...new Set(showsFor(seen))].sort((a, b) => a - b);
    const releases = [];
    const release = () => { for (const r of releases.splice(0)) r(); };
    try {
      for (const id of ids) releases.push(await acquire(`attendance:${id}`));
      seen = await read();
    } catch (err) {
      release();
      throw err;
    }
    // A row that has gone altogether did not move; the caller's own checks
    // answer that one.
    if (seen.every((r) => ids.includes(r.attendance_id))) return { rows: seen, release };
    release();
  }
  return null;
}

module.exports = {
  dateOnly, headlinerOf, INT32_MAX, sidecarSeed,
  ownAttendance, billCandidates, withOwner, refuseRows, lockShows,
};
