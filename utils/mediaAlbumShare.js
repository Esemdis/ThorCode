// A public link to a whole night's photographs and videos (THO-892).
//
// The single-file link in mediaShareToken.js is a URL to bytes: point a
// browser at it and the file opens. An album cannot be that — it is a page of
// many files — so its link is a token the frontend shows a page for, and the
// page asks this API for the listing and for each file's bytes by that token.

// Sliced from the UTC instant, never reformatted through local time: the
// reason is beside dateOnly in routes/data/media/shared.js, which this cannot
// import without pulling the database client into a pure module.
const dateOnly = (d) => new Date(d).toISOString().slice(0, 10);

// A week, where one file's link lasts twelve hours. An album is sent to
// someone who was there and wants to keep a few of the files, and they get
// round to it on a weekend, not the same evening.
const ALBUM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// A festival day folds into a handful of attendances, one per stage. Fifty is
// far past any real night and keeps one request from naming a whole account.
const MAX_ALBUM_ATTENDANCES = 50;

const ALBUM_PATH = '/data/concerts/album-shares';

function albumExpiry(now = new Date()) {
  return new Date(now.getTime() + ALBUM_TTL_MS);
}

/**
 * The attendances a request names, as the link stores them: whole positive
 * numbers, each once, ascending — so the same night asked for in another order
 * is the same list.
 *
 * Accepts the JSON array a POST carries and the comma-separated string a
 * DELETE's query does.
 *
 * @returns {number[]|null} null when the list is empty, too long, or holds
 *   anything that is not an id.
 */
function normaliseAttendanceIds(raw) {
  const parts = typeof raw === 'string' ? raw.split(',') : raw;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const ids = new Set();
  for (const part of parts) {
    // Through a string either way, so 1.5, '1abc' and true are all refused
    // rather than rounded or coerced into somebody's attendance.
    const text = typeof part === 'number' ? String(part) : part;
    if (typeof text !== 'string' || !/^[1-9]\d{0,9}$/.test(text.trim())) return null;
    const id = Number(text.trim());
    if (id > 2147483647) return null;
    ids.add(id);
  }
  if (ids.size > MAX_ALBUM_ATTENDANCES) return null;
  return [...ids].sort((a, b) => a - b);
}

const sameIds = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * The URLs a recipient's page loads one file's bytes from. Built from the
 * configured public base URL, never from the request — see mediaUrls().
 */
function albumMediaUrls(baseUrl, token, mediaId) {
  if (!baseUrl) throw new Error('No public base URL configured (CALLBACK_URL)');
  const base = String(baseUrl).replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`Public base URL (CALLBACK_URL) is not absolute: ${base}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Public base URL (CALLBACK_URL) is not http or https: ${base}`);
  }
  const root = `${base}${ALBUM_PATH}/${encodeURIComponent(token)}/media/${encodeURIComponent(mediaId)}`;
  return {
    thumb: `${root}/thumb`,
    // What the page shows: a screen-sized photograph, a video's web rendition.
    view: `${root}/view`,
    // The archive master, sent as a download. This is the "full quality" the
    // album exists to hand over, and the one thing the single-file link never
    // serves.
    file: `${root}/file`,
  };
}

/**
 * What a recipient is told about a night: where and when it was, who played,
 * and each file with what it is a recording of.
 *
 * Named field by field, never spread from the rows. The recipient is a
 * stranger to the account, and a media row also carries where the file sits in
 * the archive (rel_path, with the owner's user id in it), its checksum and
 * the recap's picks; an attendance carries the wishlist it belongs to.
 *
 * @param {object} args
 * @param {{token: string, expires_at: Date}} args.link
 * @param {object[]} args.attendances - The owner's, each with `concert_rel`
 *   (date, venue, city, country, and `bands` with `band_rel` and `setlist`).
 * @param {object[]} args.media - ConcertMedia rows, already in night order.
 * @param {string} args.baseUrl
 */
function albumPayload({ link, attendances, media, baseUrl }) {
  const concerts = attendances.map((a) => a.concert_rel);
  const dated = concerts.find((c) => c.concert_date);
  const first = concerts[0];

  // One entry per act, whichever stages listed it. The show's own setlist
  // only: that is what was played that night, and so the order the songs go
  // in. The band's most recent set from somewhere else would be a guess.
  const bands = new Map();
  for (const concert of concerts) {
    for (const b of concert.bands ?? []) {
      const known = bands.get(b.band_rel.id);
      if (!known) bands.set(b.band_rel.id, { id: b.band_rel.id, name: b.band_rel.name, setlist: b.setlist ?? null });
      else if (!known.setlist && b.setlist) known.setlist = b.setlist;
    }
  }

  return {
    expires_at: link.expires_at,
    night: {
      date: dated ? dateOnly(dated.concert_date) : null,
      venues: [...new Set(concerts.map((c) => c.venue).filter(Boolean))],
      city: first?.city ?? null,
      country: first?.country ?? null,
    },
    bands: [...bands.values()],
    files: media.map((m) => ({
      id: m.id,
      kind: m.kind,
      filename: m.filename,
      bytes: m.bytes,
      width: m.width ?? null,
      height: m.height ?? null,
      duration_ms: m.duration_ms ?? null,
      caption: m.caption ?? null,
      song: m.song ?? null,
      band_id: m.band_id ?? null,
      taken_at: m.taken_at ?? null,
      ...albumMediaUrls(baseUrl, link.token, m.id),
    })),
  };
}

module.exports = {
  ALBUM_TTL_MS, MAX_ALBUM_ATTENDANCES, albumExpiry, normaliseAttendanceIds, sameIds,
  albumMediaUrls, albumPayload,
};
