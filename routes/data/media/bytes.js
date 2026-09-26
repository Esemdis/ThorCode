/**
 * The routes that serve bytes.
 *
 * Deliberately no `auth` middleware. An <img src> and a <video src> issue their
 * own requests and cannot attach an Authorization header, so these authenticate
 * on the signed token in the query string instead. The token carries the media
 * id, so one valid URL unlocks one file and not the archive.
 *
 * res.sendFile goes through `send`, which already implements Range and
 * conditional gets. That is the whole of video seeking support.
 *
 * Split out of routes/data/media.js, which had grown to 1715 lines and
 * fourteen endpoints. media.js mounts this and its siblings in their
 * original declaration order — the manifest test in media.test.js pins
 * the resulting surface.
 */
const express = require('express');

const prisma = require('../../../prisma/client');
const { fail } = require('../../../utils/apiResponse');
const { resolveArchivePath } = require('../../../utils/mediaPaths');
const { ensureThumb, ensureDisplay } = require('../../../utils/mediaThumbs');
const { playableFor } = require('../../../utils/mediaRenditions');
const { verifyMediaToken } = require('../../../utils/mediaTokens');
const { isActiveShareLink } = require('../../../utils/mediaShareToken');
const { rateLimiter } = require('../../../utils/rateLimiter');
const { clipFiles, isClip, prepareClip } = require('../../../utils/mediaClips');
const { withOwner } = require('./shared');

const router = express.Router();

// The owner-token routes: one row's file, poster, viewing copy or original.
async function serveMedia(req, res, which) {
  try {
    // A plain parseInt accepts '1abc' as 1 and would serve media 1 under a
    // path meant to 404. Not exploitable on its own — the token still has to
    // be signed for that id — but the param should mean what it looks like.
    if (!/^[1-9]\d*$/.test(req.params.id)) return res.status(400).end();
    const mediaId = parseInt(req.params.id, 10);

    const verdict = verifyMediaToken(req.query.t, { mediaId });
    if (!verdict.ok) {
      console.warn(`[media] refused ${mediaId}: ${verdict.reason}`);
      return res.status(401).end();
    }

    const row = await prisma.concertMedia.findUnique({
      where: { id: mediaId },
      include: withOwner,
    });
    if (!row) return res.status(404).end();
    // Ownership is re-checked against the database, not taken from the token.
    // A token stays valid for six to seven hours, and the file may have
    // changed hands or been detached in that time.
    if (row.attendance_rel.wishlist_rel.user_id !== verdict.userId) return res.status(403).end();

    // A download, asked for as one. The app is served from another origin,
    // where the browser ignores <a download>, so a link to /file navigated the
    // app away to the photograph instead of saving it. Content-Disposition is
    // the one way a cross-origin response can say "save this", and it carries
    // the archive's name for the file rather than the id in the URL.
    if (which === 'file' && req.query.download === '1') res.attachment(row.filename);

    return await sendMediaBytes(res, row, which, `GET /media/:id/${which}`);
  } catch (err) {
    return fail(res, err, { context: `GET /media/:id/${which}` });
  }
}

/**
 * Stream one row's bytes, once the caller has been authorized by whatever
 * means its route uses. Shared by the owner-token routes above and the public
 * share route below, so both get the same confinement, caching and
 * mid-body-abort handling.
 *
 * Throws on an archive-escape refusal; the caller's catch logs it.
 *
 * `cacheControl` overrides the header below for a caller whose authorization
 * can end before the bytes change — see the share route.
 */
async function sendMediaBytes(res, row, which, context, { cacheControl } = {}) {
  // Resolved before the thumb/poster branch, and outside its try: an
  // archive-escape refusal here is the single most important thing these
  // routes can produce and must reach the outer catch and get logged, not
  // be caught below and mistaken for "this video has no poster".
  const archivePath = resolveArchivePath(row.rel_path);

  let absPath;
  // A rendition that appears later must not be masked by a year-old cached
  // original, so `immutable` is only claimed once there is nothing left to
  // supersede. See the Cache-Control below.
  let servingOriginalForPlayback = false;
  // /view is what the lightbox shows. A video's viewing copy is whatever /play
  // chooses, so for a video /view is /play in every respect — the short cache
  // while the original stands in for a rendition included.
  if (which === 'play' || (which === 'view' && row.kind === 'VIDEO')) {
    const chosen = await playableFor(archivePath, row.kind);
    absPath = chosen.absPath;
    servingOriginalForPlayback = !chosen.rendition && row.kind === 'VIDEO';
  } else if (which === 'thumb') {
    try {
      absPath = await ensureThumb({
        absPath: archivePath, kind: row.kind, sha256: row.sha256, relPath: row.rel_path,
      });
    } catch (err) {
      if (err.code !== 'NO_POSTER' && err.code !== 'NO_SOURCE') throw err;
      // A video whose poster extraction failed in the browser has none, and
      // nothing here can decode one. NO_SOURCE is the same answer for a
      // photo whose original is gone, which is what the file route already
      // says about the same row. 404 so the grid draws its placeholder
      // rather than retrying an image that is never coming.
      return res.status(404).end();
    }
  } else if (which === 'view') {
    // A photograph's is a copy sized for a screen, made on first request and
    // keyed by checksum like a thumbnail, which is why the immutable cache
    // below suits it.
    try {
      absPath = await ensureDisplay({ absPath: archivePath, sha256: row.sha256 });
    } catch (err) {
      // An original that is gone, answered as the thumb route answers it.
      if (err.code !== 'NO_SOURCE') throw err;
      return res.status(404).end();
    }
  } else {
    absPath = archivePath;
  }

  // Immutable: these paths are keyed by content that never changes in place.
  // A replaced photo is a new row with a new id.
  //
  // Except one case. /play serves the original until the rendition service
  // reaches that clip, and then serves the rendition from the same URL — so
  // telling the browser to keep the original for a year would hide the
  // rendition behind a cache entry nothing can invalidate. Five minutes keeps
  // a scroll cheap and lets the better copy arrive.
  res.set('Cache-Control', cacheControl ?? (servingOriginalForPlayback
    ? 'private, max-age=300'
    : 'private, max-age=31536000, immutable'));
  return sendFileSafely(res, absPath, context);
}

/**
 * res.sendFile, with the error handling every byte route here needs. Separate
 * from sendMediaBytes because a shared moment is not a row's file at all — it
 * is a cut in the cache — and needs exactly the same care.
 *
 * The caller sets Cache-Control first.
 */
function sendFileSafely(res, absPath, context) {
  // `send` defaults to dotfiles: 'ignore' and 404s a path with a dot segment
  // regardless of permissions. A poster lives at <show>/.posters/<name>.webp,
  // so without this every video thumb was a silent placeholder even with the
  // poster sitting right there on disk. It applies to the file route too,
  // and for a reason that has nothing to do with posters: with no `root`
  // option set, send tests every segment of the ABSOLUTE path, so a single
  // dot directory anywhere in MEDIA_ROOT turns every download in the archive
  // into a 404. resolveArchivePath has already confined the path by this
  // point, so send's dotfile heuristic guards nothing here and only breaks
  // deploys whose mount happens to sit under a hidden directory.
  const sendOpts = { dotfiles: 'allow' };

  // mime-types 3 answers application/mp4 for .mp4, and send takes its word. A
  // <video> plays that regardless, but a share link opened straight in a
  // browser tab can be offered as a download instead of played. Every .mp4
  // here is a video — renditions, cut moments, phone originals — and send
  // keeps a type that is already set.
  if (absPath.endsWith('.mp4')) res.type('video/mp4');

  return res.sendFile(absPath, sendOpts, (err) => {
    if (!err) return;
    // send's ENOENT carries a 404 status, and the global handler keeps an
    // error's message for any status under 500 even in production — which
    // would otherwise hand an absolute archive path on this container back
    // to the browser. The caller is already authorized for this file, so this
    // is closing a filesystem-layout leak, not a data leak.
    if (err.code === 'ENOENT') {
      // An immutable Cache-Control is set before sendFile runs, so
      // without this it is still on the response when this 404 goes out —
      // and the browser is told to remember the miss for a year. The
      // condition that produces it is usually transient (a share that
      // dropped, or mounted late after a restart), so every tile looked at
      // during the outage stayed broken long after it ended.
      res.removeHeader('Cache-Control');
      return res.status(404).end();
    }
    // Passing a callback here opts out of Express's own next(err) handling
    // (see res.sendFile's source: "if (done) return done(err)"), so
    // anything past ENOENT has to be logged and answered here, not thrown —
    // this runs after the surrounding try/catch has already returned.
    //
    // Opting out also loses the res.headersSent guard that Express's default
    // error handler applies, and that is the half that bites. Every error
    // send reports mid-body arrives after the headers: the common one is a
    // client that closed the tab or seeked in a video, which send reports as
    // "Request aborted". Calling fail() there tried to write a second
    // response, threw ERR_HTTP_HEADERS_SENT from inside send's own callback
    // where nothing catches it, and index.js answers uncaughtException with
    // process.exit(1) — so one viewer scrubbing a video took the whole API
    // down with it, on a feature whose stated premise is a flaky home
    // connection. Once the response is committed the only honest move is to
    // log it and drop the socket.
    if (res.headersSent) {
      console.error(`[${new Date().toISOString()}] ${context} aborted mid-body`, err);
      return res.destroy();
    }
    return fail(res, err, { context });
  });
}

router.get('/media/:id/file', (req, res) => serveMedia(req, res, 'file'));
// The viewing copy: the web rendition when one has been made, the original
// until then. Separate from /file so a download always gets the master.
router.get('/media/:id/play', (req, res) => serveMedia(req, res, 'play'));
router.get('/media/:id/thumb', (req, res) => serveMedia(req, res, 'thumb'));
// The lightbox's copy: a photograph at screen size rather than the phone's
// full-resolution original, and for a video exactly what /play answers.
router.get('/media/:id/view', (req, res) => serveMedia(req, res, 'view'));

/**
 * A share link, opened by someone with no account.
 *
 * Unknown, revoked and expired all answer 404, never 403 — the calendar feed's
 * rule, for the same reason: a different answer would confirm the token
 * exists.
 *
 * Always the /play copy, for either kind: for a photograph that is the
 * original, and for a video it is the web rendition when there is one. The
 * link has to just work when a browser is pointed straight at it, and a 4K
 * HEVC master does not.
 *
 * A moment of a video is its own cut, made by the rendition service; until it
 * exists the link answers a page that says so and reloads itself.
 *
 * no-store, not the byte routes' year-long immutable: the link is meant to
 * stop working, and a cached copy would keep opening in the recipient's
 * browser after it had been revoked.
 */
const shareLimiter = rateLimiter({
  message: 'Too many requests for this link, please try again later.',
  windowMs: 60 * 60 * 1000,
  max: 300,
});

const SHARE_CONTEXT = 'GET /media/share/:token';

// For a recipient who opens a moment before it has been cut. Few will — the
// owner sees "preparing" and usually waits — so this only has to be honest and
// come back on its own. 503 with Retry-After rather than 200, so nothing
// mistakes the page for the clip.
const PREPARING_PAGE = '<!doctype html><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<meta http-equiv="refresh" content="5"><title>Almost ready</title>'
  + '<p style="font:16px/1.5 system-ui,sans-serif;margin:2rem">'
  + 'This clip is still being prepared. The page will reload by itself in a few seconds.</p>';

async function servePublicShare(req, res) {
  try {
    const link = await prisma.mediaShareLink.findUnique({ where: { token: req.params.token } });
    if (!isActiveShareLink(link)) return res.status(404).end();

    const row = await prisma.concertMedia.findUnique({ where: { id: link.media_id } });
    if (!row) return res.status(404).end();

    if (!isClip(link)) {
      return await sendMediaBytes(res, row, 'play', SHARE_CONTEXT, { cacheControl: 'private, no-store' });
    }

    const status = await prepareClip(link, row);
    res.set('Cache-Control', 'private, no-store');
    if (status === 'ready') return sendFileSafely(res, clipFiles(link.id).output, SHARE_CONTEXT);
    // A cut ffmpeg refused will not succeed on a reload, so not the page that
    // promises one.
    if (status === 'failed') return res.status(404).end();
    res.set('Retry-After', '5');
    return res.status(503).type('html').send(PREPARING_PAGE);
  } catch (err) {
    return fail(res, err, { context: SHARE_CONTEXT });
  }
}

router.get('/media/share/:token', shareLimiter, servePublicShare);

module.exports = router;
