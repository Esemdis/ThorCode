/**
 * A shared moment: a stretch of one video, cut into its own file for a share
 * link.
 *
 * The API and the rendition service split the work without ever talking. The
 * API owns the link (it is a Postgres row) and writes a request file; the
 * service, which has ffmpeg and deliberately no database, finds the request,
 * cuts the clip and records it by the output existing. The same arrangement as
 * `.web` renditions, for the same reasons.
 *
 * Everything lives in cache/clips rather than beside the original. A clip lasts
 * twelve hours and belongs to a link, not to the show, and cache/ is the part of
 * MEDIA_ROOT that is never copied offsite and may be deleted at any time — the
 * API writes a missing request again the next time anyone asks after the link.
 *
 * Files are named by the link's id, never by its token. The token is the
 * credential, and a directory listing is no place for one.
 */

const path = require('node:path');
const { randomBytes } = require('node:crypto');
const {
  access, mkdir, readdir, readFile, rename, unlink, writeFile,
} = require('node:fs/promises');
const { clipCacheRoot } = require('./mediaPaths');
const { FAILED_SUFFIX, PART_SUFFIX } = require('./renditionPlan');

// Shorter than this is a still with a soundtrack, and far more likely a
// double-press on "End here" than a moment anyone meant to share.
const MIN_CLIP_MS = 1000;

const REQUEST_NAME = /^(\d+)\.json$/;
// The API's temp name while it writes a request. Never swept: the service could
// otherwise delete one between the API's write and its rename.
const TEMP_NAME = /^\.\d+\.json\.[0-9a-f]+\.tmp$/;

const exists = (p) => access(p).then(() => true, () => false);

function clipFiles(id, root = clipCacheRoot()) {
  const output = path.join(root, `${id}.mp4`);
  return {
    request: path.join(root, `${id}.json`),
    output,
    failed: `${output}${FAILED_SUFFIX}`,
    part: `${output}${PART_SUFFIX}`,
  };
}

/**
 * The range a share asked for, normalised so that asking for the same moment
 * twice finds the same link — or `{ error }`.
 *
 * Neither end given is the whole file. Only a start runs to the end of the
 * video; only an end starts at the beginning. An end at or past the video's
 * length is the same as no end, and a "moment" from 0 to the end is simply the
 * whole video, which is shared as the file rather than cut into a copy of it.
 *
 * @param {{start_ms?: number|null, end_ms?: number|null}} asked
 * @param {{durationMs?: number|null}} [video]
 * @returns {{range: {start_ms: number|null, end_ms: number|null}} | {error: string}}
 */
function normaliseRange({ start_ms: start = null, end_ms: end = null }, { durationMs = null } = {}) {
  const whole = { range: { start_ms: null, end_ms: null } };
  if (start == null && end == null) return whole;

  const from = start ?? 0;
  let to = end;
  if (durationMs != null) {
    if (from >= durationMs) return { error: 'That moment starts after the video ends' };
    if (to != null && to >= durationMs) to = null;
  }
  if (to != null && to - from < MIN_CLIP_MS) return { error: 'A moment has to be at least a second long' };
  if (from === 0 && to == null) return whole;
  return { range: { start_ms: from, end_ms: to } };
}

const isClip = (link) => link.start_ms != null || link.end_ms != null;

/** What the service is told to cut, written as `<id>.json`. */
function clipRequest(link, row) {
  return {
    id: link.id,
    rel_path: row.rel_path,
    start_ms: link.start_ms ?? 0,
    end_ms: link.end_ms ?? null,
    // So the service can delete the clip once the link is dead, without a
    // database to ask.
    expires_at: new Date(link.expires_at).toISOString(),
  };
}

const isMs = (n) => Number.isInteger(n) && n >= 0;

/**
 * A request file's contents, or null for anything the service should not act
 * on. The id inside has to match the file's own name, so a copied or renamed
 * request cannot cut one link's clip under another's.
 */
function parseClipRequest(name, text) {
  const match = REQUEST_NAME.exec(name);
  if (!match) return null;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (json?.id !== Number(match[1])) return null;
  if (typeof json.rel_path !== 'string' || !json.rel_path) return null;
  if (!isMs(json.start_ms)) return null;
  if (json.end_ms != null && !(isMs(json.end_ms) && json.end_ms > json.start_ms)) return null;
  if (Number.isNaN(new Date(json.expires_at).getTime())) return null;
  return {
    id: json.id,
    rel_path: json.rel_path,
    start_ms: json.start_ms,
    end_ms: json.end_ms ?? null,
    expires_at: new Date(json.expires_at),
  };
}

/**
 * What the service should cut and what it should delete, from one listing of
 * cache/clips.
 *
 * Pure, so it can be tested without ffmpeg or a share. Only ever called between
 * cuts, which is what makes every `.part` it sees an abandoned one.
 *
 * @param {string[]} names - the directory's entries
 * @param {Map<string, object|null>} requests - each `<id>.json` name, parsed
 *   with parseClipRequest (null when unreadable)
 * @param {Date} now
 * @returns {{jobs: object[], sweep: string[]}}
 *
 * A failed clip is not retried here — the queue is polled every few seconds,
 * so a retry flag would re-run a broken cut just as often. Stopping the share
 * and sharing again mints a new link, and with it a fresh attempt.
 */
function planClips(names, requests, now = new Date()) {
  const present = new Set(names);
  const jobs = [];
  const sweep = new Set();
  const live = new Set();

  for (const [name, request] of requests) {
    const id = REQUEST_NAME.exec(name)?.[1];
    if (!id) continue;
    const own = [name, `${id}.mp4`, `${id}.mp4${FAILED_SUFFIX}`];
    // Expired, or not a request at all: the link it served is dead either way.
    if (!request || request.expires_at <= now) {
      own.filter((n) => present.has(n)).forEach((n) => sweep.add(n));
      continue;
    }
    live.add(id);
    if (!present.has(`${id}.mp4`) && !present.has(`${id}.mp4${FAILED_SUFFIX}`)) jobs.push(request);
  }

  for (const name of names) {
    if (TEMP_NAME.test(name)) continue;
    if (name.endsWith(PART_SUFFIX)) { sweep.add(name); continue; }
    // An output or marker whose request is gone: its link was revoked, possibly
    // while this very clip was being cut.
    const id = /^(\d+)\./.exec(name)?.[1];
    if (id && !live.has(id) && !REQUEST_NAME.test(name)) sweep.add(name);
  }

  return { jobs, sweep: [...sweep] };
}

/**
 * Where a link's clip stands — 'ready', 'failed' or 'preparing' — writing the
 * request for the service when there is nothing yet.
 *
 * Writing on every ask rather than once at creation is what makes cache/
 * deletable: a request lost with it is simply written again.
 */
async function prepareClip(link, row, root = clipCacheRoot()) {
  const files = clipFiles(link.id, root);
  if (await exists(files.output)) return 'ready';
  if (await exists(files.failed)) return 'failed';
  if (await exists(files.request)) return 'preparing';

  await mkdir(root, { recursive: true });
  // Unique per write, as the sidecar's is: two polls of the same link can race.
  const temp = path.join(root, `.${link.id}.json.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(temp, `${JSON.stringify(clipRequest(link, row))}\n`, 'utf8');
  try {
    await rename(temp, files.request);
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
  return 'preparing';
}

/**
 * Delete a link's clip and request. The request goes first, so the service
 * starts nothing new for it; one it is already cutting is deleted by the
 * service when it finds the request gone.
 */
async function removeClip(id, root = clipCacheRoot()) {
  const files = clipFiles(id, root);
  for (const p of [files.request, files.output, files.failed]) {
    await unlink(p).catch(() => {});
  }
}

/**
 * Point every waiting request at `fromRelPath` to `toRelPath` instead —
 * called when tagging moves a video out from under a request nobody has
 * cut yet. Without this the service goes on trying to read a path the file
 * just left, and the moment sits at "preparing" forever.
 *
 * A request already cut, or already marked failed, names no path worth
 * fixing — the service is done reading the source either way — so only a
 * request still waiting is rewritten. Same temp-then-rename dance as
 * `prepareClip`, for the same reason: the service lists this directory
 * between cuts and must never see a half-written request.
 *
 * @returns {Promise<number[]>} ids rewritten, so a failed move elsewhere can
 *   undo this by calling it again with the paths swapped
 */
async function retargetClipRequests(fromRelPath, toRelPath, root = clipCacheRoot()) {
  const names = await readdir(root).catch((err) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  const moved = [];
  for (const name of names) {
    const match = REQUEST_NAME.exec(name);
    if (!match) continue;
    const id = Number(match[1]);
    const text = await readFile(path.join(root, name), 'utf8').catch(() => null);
    const request = text == null ? null : parseClipRequest(name, text);
    if (!request || request.rel_path !== fromRelPath) continue;

    const files = clipFiles(id, root);
    // Already cut, or already given up on: nothing here still points at the
    // source, so there is nothing to retarget.
    if (await exists(files.output) || await exists(files.failed)) continue;

    const temp = path.join(root, `.${id}.json.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(temp, `${JSON.stringify({ ...request, id, rel_path: toRelPath })}\n`, 'utf8');
    try {
      await rename(temp, files.request);
    } catch (err) {
      await unlink(temp).catch(() => {});
      throw err;
    }
    moved.push(id);
  }
  return moved;
}

module.exports = {
  MIN_CLIP_MS,
  clipFiles,
  normaliseRange,
  isClip,
  clipRequest,
  parseClipRequest,
  planClips,
  prepareClip,
  removeClip,
  retargetClipRequests,
};
