/**
 * The video rendition service.
 *
 * The archive holds phone originals and they are not viewing copies. One night's
 * clips measured 43.4 Mbit/s of 4K HEVC — 1.18 GB for three minutes and 43
 * seconds, 9.26 GB for the gig — which no browser streams smoothly over a home
 * connection, which Firefox cannot decode at all, and which a phone writes with
 * its index at the END of the file so a player must fetch the tail of a gigabyte
 * before it can begin.
 *
 * This walks the archive, finds clips with no rendition, and writes
 * `.web/<name>.mp4` beside each one: 1080p H.264, AAC, index at the front. The
 * API serves that for playback and the original for download, so the archive
 * copy is never touched or replaced.
 *
 * It is a separate service for one reason: ffmpeg is roughly 250 MB, and the API
 * image also serves the travel app and is pulled on every Watchtower check. The
 * decoder belongs where the decoding happens.
 *
 * What it needs is deliberately almost nothing — MEDIA_ROOT and ffmpeg. No
 * DATABASE_URL, no Doppler token, no API credentials, no network at all. It
 * finds its work in the sidecars, which are the record of truth, and records a
 * finished rendition by the file existing. So it cannot corrupt the index (it
 * never opens it), it cannot leak a secret (it holds none), and it can be killed
 * at any moment.
 *
 *   node services/rendition/index.js --once      # one pass, then exit
 *   node services/rendition/index.js --dry-run   # say what is pending
 *   node services/rendition/index.js             # loop forever
 *   node services/rendition/index.js --retry     # clear .failed markers first
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  readdir, mkdir, rename, unlink, stat, writeFile,
} = require('node:fs/promises');

const { archiveRoot, DETACHED_DIR, WEB_DIR } = require('../../utils/mediaPaths');
const { archiveStatus } = require('../../utils/mediaHealth');
const { readSidecar } = require('../../utils/mediaSidecar');
const {
  ffmpegArgs, pendingInShow, isAbandonedPart, partNameFor, FAILED_SUFFIX,
} = require('../../utils/renditionPlan');

const args = process.argv.slice(2);
const once = args.includes('--once');
const dryRun = args.includes('--dry-run');
const retry = args.includes('--retry');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const HEIGHT = Number(process.env.RENDITION_HEIGHT || 1080);
const CRF = Number(process.env.RENDITION_CRF || 21);
const MAXRATE = Number(process.env.RENDITION_MAXRATE_MBPS || 8);
// Overridable because a box with a GPU should use it: h264_nvenc, h264_qsv or
// h264_vaapi turn hours of 4K into minutes. libx264 is the default because it is
// the one encoder every build of ffmpeg has.
const VCODEC = process.env.RENDITION_VCODEC || 'libx264';
const PRESET = process.env.RENDITION_PRESET || 'veryfast';
const INTERVAL = Number(process.env.RENDITION_INTERVAL_SECONDS || 300);

const log = (...m) => console.log(`[rendition] ${m.join(' ')}`);
const warn = (...m) => console.warn(`[rendition] ${m.join(' ')}`);

const dirsIn = async (abs) => (await readdir(abs, { withFileTypes: true }))
  .filter((e) => e.isDirectory()).map((e) => e.name);

const filesIn = async (abs) => readdir(abs).catch(() => []);

const mb = (n) => (n == null ? '?' : `${Math.round(n / 1e6)} MB`);

let stopping = false;
// Cuts the idle wait short. The sleep timer has to keep the process alive —
// unreferenced, nothing else is pending between passes and the service would
// exit rather than wait — so a signal has to be able to clear it instead.
let wake = null;
// A transcode is minutes long, so a signal has to be able to arrive mid-encode.
// The child is killed, its .part removed by the runner's own catch, and the loop
// exits — leaving the archive exactly as it was.
let child = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) process.exit(130);
    stopping = true;
    log(`${signal} — finishing up`);
    if (child) child.kill('SIGTERM');
    if (wake) wake();
  });
}

/** Every show folder in the archive, skipping the detached ones. */
async function showDirs() {
  const root = archiveRoot();
  const found = [];
  for (const user of await dirsIn(root)) {
    for (const show of await dirsIn(path.join(root, user))) {
      // Detached shows are not served, so a rendition of one would be CPU spent
      // on something no request can reach. Same exclusion collectArchive makes,
      // for the same reason.
      if (show === DETACHED_DIR) continue;
      found.push({ label: path.posix.join(user, show), abs: path.join(root, user, show) });
    }
  }
  return found;
}

/** Run ffmpeg once. Resolves on success, rejects with stderr on failure. */
function runFfmpeg(ffArgs) {
  return new Promise((resolve, reject) => {
    child = spawn(FFMPEG, ffArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    // Bounded: a failing encode can produce megabytes of the same line, and the
    // first part is what says why.
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString(); });
    child.on('error', (err) => { child = null; reject(err); });
    child.on('close', (code, signal) => {
      child = null;
      if (code === 0) return resolve();
      return reject(new Error(signal
        ? `ffmpeg killed by ${signal}`
        : `ffmpeg exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' / ') || 'no output'}`));
    });
  });
}

/**
 * Encode one clip into its show's `.web`.
 *
 * Writes `<name>.mp4.part` and renames on success, so the serving route — which
 * decides on existence alone — can never be handed a partial file.
 */
async function encode(show, job) {
  const webDir = path.join(show.abs, WEB_DIR);
  const input = path.join(show.abs, job.name);
  const target = path.join(webDir, job.output);
  const part = path.join(webDir, partNameFor(job.output));

  await mkdir(webDir, { recursive: true });

  const started = Date.now();
  try {
    await runFfmpeg(ffmpegArgs({
      input,
      output: part,
      height: HEIGHT,
      crf: CRF,
      maxrateMbps: MAXRATE,
      vcodec: VCODEC,
      preset: PRESET,
    }));
  } catch (err) {
    await unlink(part).catch(() => {});
    // Not marked as failed when we are the reason it stopped. A killed encode is
    // unfinished work, not a broken file, and marking it would quietly exclude a
    // perfectly good clip from every future pass.
    if (stopping) throw err;
    // The marker is next to the output so one glance at .web says which clips
    // were refused and why, and so the next pass does not spend itself retrying
    // a file ffmpeg cannot read. `--retry` clears them.
    await writeFile(path.join(webDir, `${job.output}${FAILED_SUFFIX}`), `${err.message}\n`)
      .catch(() => {});
    warn(`${show.label}/${job.name}: ${err.message}`);
    return { ok: false };
  }

  await rename(part, target);
  const after = await stat(target).then((st) => st.size, () => null);
  const seconds = Math.round((Date.now() - started) / 1000);
  log(`${show.label}/${job.name}: ${mb(job.bytes)} → ${mb(after)} in ${seconds}s`);
  return { ok: true, before: job.bytes ?? 0, after: after ?? 0 };
}

/** Delete `.part` files and, with --retry, the failure markers. */
async function tidy(show) {
  const webDir = path.join(show.abs, WEB_DIR);
  for (const name of await filesIn(webDir)) {
    // A .part can only be a killed run's leftover: nothing else writes one, and
    // ffmpeg cannot resume into a truncated file.
    if (isAbandonedPart(name)) await unlink(path.join(webDir, name)).catch(() => {});
    if (retry && name.endsWith(FAILED_SUFFIX)) await unlink(path.join(webDir, name)).catch(() => {});
  }
}

async function pass() {
  const shows = await showDirs();
  let pending = 0;
  let done = 0;
  let failed = 0;
  let before = 0;
  let after = 0;

  for (const show of shows) {
    if (stopping) break;
    await tidy(show);

    let sidecar;
    try {
      sidecar = await readSidecar(show.abs);
    } catch (err) {
      // A show nobody can read is the rebuild script's finding to report, not
      // this service's to act on. Skipped so the other two hundred still get
      // their renditions.
      warn(`${show.label}: sidecar unreadable, skipping — ${err.message}`);
      continue;
    }

    const jobs = pendingInShow(sidecar, await filesIn(path.join(show.abs, WEB_DIR)));
    pending += jobs.length;

    for (const job of jobs) {
      if (stopping) break;
      if (dryRun) {
        log(`would encode ${show.label}/${job.name} (${mb(job.bytes)})`);
        continue;
      }
      // Strictly one at a time. This shares a box with the API and the array;
      // two concurrent 4K transcodes would make the app it exists to improve
      // slower than it was.
      const result = await encode(show, job);
      if (result.ok) { done += 1; before += result.before; after += result.after; }
      else failed += 1;
    }
  }

  if (dryRun) {
    log(`${pending} clip${pending === 1 ? '' : 's'} pending across ${shows.length} show${shows.length === 1 ? '' : 's'}; nothing written`);
    return pending;
  }

  if (done || failed) {
    const saved = before && after ? ` — ${mb(before)} of originals became ${mb(after)}` : '';
    log(`pass done: ${done} encoded, ${failed} refused${saved}`);
  }
  return pending;
}

async function main() {
  // Asked before anything walks, and the same question every other script in
  // this repo asks first. An unmounted share is the expected failure here — this
  // runs on a box whose array can drop — and it used to surface as a raw ENOENT
  // stack trace naming a directory, leaving the operator to work out that "check
  // the mount" was what it meant.
  const archive = await archiveStatus();
  if (!archive.readable) {
    console.error(`[rendition] no usable archive at ${archive.root ?? '(MEDIA_ROOT unset)'}`
      + ` (${archive.reason}) — is the media share mounted?`);
    process.exitCode = 1;
    return;
  }
  log(`archive ${archiveRoot()}, ${VCODEC} at ${HEIGHT}p, crf ${CRF}, ceiling ${MAXRATE} Mbit/s`);

  if (dryRun || once) { await pass(); return; }

  // A loop rather than a cron entry: an encode runs for minutes and overlapping
  // runs would fight for the same CPU and the same .part path. Sleeping between
  // passes means there is only ever one.
  while (!stopping) {
    await pass();
    if (stopping) break;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { wake = null; resolve(); }, INTERVAL * 1000);
      wake = () => { clearTimeout(timer); wake = null; resolve(); };
    });
  }
  log('stopped');
}

main().catch((err) => {
  console.error('[rendition]', err);
  process.exitCode = 1;
});
