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
 * It also cuts shared moments: a share link to part of a clip is a request file
 * the API writes into cache/clips, and this cuts that stretch into its own mp4
 * beside it (see utils/mediaClips.js). Someone is waiting on those with the
 * share panel open, so the clip queue is checked every few seconds and ahead of
 * each rendition, where the archive walk runs only every INTERVAL.
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
  access, readdir, readFile, mkdir, rename, unlink, stat, writeFile,
} = require('node:fs/promises');

const {
  archiveRoot, clipCacheRoot, resolveArchivePath, DETACHED_DIR, WEB_DIR,
} = require('../../utils/mediaPaths');
const { archiveStatus } = require('../../utils/mediaHealth');
const { readSidecar } = require('../../utils/mediaSidecar');
const {
  ffmpegArgs, probeArgs, parseProbe, targetSize,
  pendingInShow, isAbandonedPart, partNameFor, FAILED_SUFFIX,
} = require('../../utils/renditionPlan');
const { playableFor } = require('../../utils/mediaRenditions');
const { clipFiles, parseClipRequest, planClips } = require('../../utils/mediaClips');

const args = process.argv.slice(2);
const once = args.includes('--once');
const dryRun = args.includes('--dry-run');
const retry = args.includes('--retry');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const HEIGHT = Number(process.env.RENDITION_HEIGHT || 1080);
const CRF = Number(process.env.RENDITION_CRF || 21);
const MAXRATE = Number(process.env.RENDITION_MAXRATE_MBPS || 8);
// Overridable because a box with a GPU should use it. h264_nvenc moves the HEVC
// decode onto NVDEC and the encode onto NVENC, which on these 4K clips is most
// of the work. libx264 is the default because it is the one encoder every build
// of ffmpeg has.
const VCODEC = process.env.RENDITION_VCODEC || 'libx264';
// Left unset so each encoder gets its own default: NVENC's presets are p1..p7
// and would reject x264's names outright.
const PRESET = process.env.RENDITION_PRESET || null;
const INTERVAL = Number(process.env.RENDITION_INTERVAL_SECONDS || 300);
const CLIP_POLL = Number(process.env.RENDITION_CLIP_POLL_SECONDS || 5);

const log = (...m) => console.log(`[rendition] ${m.join(' ')}`);
const warn = (...m) => console.warn(`[rendition] ${m.join(' ')}`);

const dirsIn = async (abs) => (await readdir(abs, { withFileTypes: true }))
  .filter((e) => e.isDirectory()).map((e) => e.name);

const filesIn = async (abs) => readdir(abs).catch(() => []);

const exists = (p) => access(p).then(() => true, () => false);

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

/** Run a child process, resolving with its stdout. Rejects with its stderr. */
function run(bin, argv, { wantStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    child = spawn(bin, argv, { stdio: ['ignore', wantStdout ? 'pipe' : 'ignore', 'pipe'] });
    let out = '';
    let stderr = '';
    if (wantStdout) child.stdout.on('data', (d) => { out += d.toString(); });
    // Bounded: a failing encode can produce megabytes of the same line, and the
    // first part is what says why.
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString(); });
    child.on('error', (err) => { child = null; reject(err); });
    child.on('close', (code, signal) => {
      child = null;
      if (code === 0) return resolve(out);
      return reject(new Error(signal
        ? `${path.basename(bin)} killed by ${signal}`
        : `${path.basename(bin)} exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' / ') || 'no output'}`));
    });
  });
}

/**
 * What the clip actually is: size, bit depth and colour.
 *
 * Asked per file rather than taken from the sidecar, because the sidecar's
 * width and height are nullable and its colour is not recorded at all — and
 * colour is what decides the entire filter chain. These clips are HLG BT.2020,
 * which has to be tone-mapped or the rendition comes out washed-out and grey.
 */
async function probe(input) {
  return parseProbe(await run(FFPROBE, probeArgs(input), { wantStdout: true }));
}

/** Run ffmpeg once. Resolves on success, rejects with stderr on failure. */
const runFfmpeg = (ffArgs) => run(FFMPEG, ffArgs);

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
    const source = await probe(input);
    // Refused rather than guessed at. Without dimensions there is no scale to
    // ask for, and inventing one would mean a rendition at the wrong size or an
    // encode that fails several minutes in.
    if (!source) throw new Error('ffprobe found no usable video stream');

    const size = targetSize(source, HEIGHT);
    log(`${show.label}/${job.name}: ${source.width}x${source.height}`
      + `${source.hdr ? ` ${source.transfer} HDR` : ''} → ${size.width}x${size.height}`);

    await runFfmpeg(ffmpegArgs({
      input,
      output: part,
      source,
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

/**
 * Cut one shared moment into cache/clips.
 *
 * From the viewing copy when there is one: already 1080p SDR H.264, so a
 * twenty-second moment costs seconds rather than a 4K HEVC decode and a tone
 * map. It is also the file the moment was picked in — the lightbox plays /play
 * — so the times in the request are on its timeline.
 */
async function cutClip(job) {
  const files = clipFiles(job.id);
  const range = `${job.start_ms / 1000}s–${job.end_ms == null ? 'end' : `${job.end_ms / 1000}s`}`;
  const started = Date.now();
  try {
    const { absPath: input } = await playableFor(resolveArchivePath(job.rel_path), 'VIDEO');
    const source = await probe(input);
    if (!source) throw new Error('ffprobe found no usable video stream');
    await runFfmpeg(ffmpegArgs({
      input,
      output: files.part,
      source,
      height: HEIGHT,
      crf: CRF,
      maxrateMbps: MAXRATE,
      vcodec: VCODEC,
      preset: PRESET,
      startMs: job.start_ms,
      durationMs: job.end_ms == null ? null : job.end_ms - job.start_ms,
    }));
  } catch (err) {
    await unlink(files.part).catch(() => {});
    // As with a rendition: a cut we stopped is unfinished, not broken.
    if (stopping) throw err;
    await writeFile(files.failed, `${err.message}\n`).catch(() => {});
    warn(`clip ${job.id} (${job.rel_path} ${range}): ${err.message}`);
    return;
  }

  await rename(files.part, files.output);
  // Revoked mid-cut. The API deleted the request, and could not delete an
  // output that did not exist yet, so it falls to this side.
  if (!(await exists(files.request))) {
    await unlink(files.output).catch(() => {});
    log(`clip ${job.id}: revoked while it was being cut, discarded`);
    return;
  }
  log(`clip ${job.id} (${job.rel_path} ${range}): cut in ${Math.round((Date.now() - started) / 1000)}s`);
}

/** Sweep dead clips, then cut any that are waiting. Cheap when there are none. */
async function clips() {
  const root = clipCacheRoot();
  const names = await filesIn(root);
  if (!names.length) return;

  const requests = new Map();
  for (const name of names.filter((n) => /^\d+\.json$/.test(n))) {
    // Gone between the listing and the read means revoked just now, which the
    // plan then treats the same as unreadable: sweep what is left of it.
    const text = await readFile(path.join(root, name), 'utf8').catch(() => null);
    requests.set(name, text == null ? null : parseClipRequest(name, text));
  }
  const { jobs, sweep } = planClips(names, requests, new Date());

  if (dryRun) {
    for (const job of jobs) log(`would cut clip ${job.id} from ${job.rel_path}`);
    return;
  }
  for (const name of sweep) await unlink(path.join(root, name)).catch(() => {});
  for (const job of jobs) {
    if (stopping) return;
    await cutClip(job);
  }
}

async function pass() {
  await clips();
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
      // A waiting clip goes first, so a backlog of renditions after a big
      // upload delays a share by one encode at most rather than the whole pile.
      await clips();
      if (stopping) break;
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
  log(`archive ${archiveRoot()}, ${VCODEC} at ${HEIGHT}p, quality ${CRF}, ceiling ${MAXRATE} Mbit/s,`
    + ` clips checked every ${CLIP_POLL}s`);

  if (dryRun || once) { await pass(); return; }

  const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });

  // A loop rather than a cron entry: an encode runs for minutes and overlapping
  // runs would fight for the same CPU and the same .part path. Everything runs
  // on this one loop, so there is only ever one encode or cut at a time.
  while (!stopping) {
    await pass();
    // Between archive walks only the clip queue is watched, and often: a clip
    // has someone waiting on it and a rendition does not.
    const due = Date.now() + INTERVAL * 1000;
    while (!stopping && Date.now() < due) {
      await sleep(Math.min(CLIP_POLL * 1000, due - Date.now()));
      if (!stopping) await clips();
    }
  }
  log('stopped');
}

main().catch((err) => {
  console.error('[rendition]', err);
  process.exitCode = 1;
});
