/**
 * Where a photo lives on disk.
 *
 * The archive is meant to be read by a human in a file browser, so these names
 * are readable rather than machine-friendly: spaces, case and the original
 * filename all survive. Nothing ever parses meaning back out of a path — the
 * sidecar carries the identifiers — so a venue renamed upstream cannot break
 * the index.
 */

const path = require('path');

const ARCHIVE_DIR = 'archive';
const CACHE_DIR = 'cache';
const DETACHED_DIR = '_detached';
const POSTERS_DIR = '.posters';
const WEB_DIR = '.web';

// Long enough for any real venue or band, short enough that a nested path stays
// well inside the 255-byte per-component limit with a suffix added.
const MAX_SEGMENT = 80;

// Illegal on SMB even where ext4 would allow them. The share is mounted over
// SMB on Unraid, so the stricter rule is the one that applies.
const ILLEGAL = /[<>:"/\\|?*]/g;

function mediaRoot() {
  const root = process.env.MEDIA_ROOT;
  if (!root) throw new Error('MEDIA_ROOT is not set');
  return root;
}

function archiveRoot() {
  return path.join(mediaRoot(), ARCHIVE_DIR);
}

function thumbCacheRoot() {
  return path.join(mediaRoot(), CACHE_DIR, 'thumbs');
}

/**
 * One path component, made safe without being made ugly.
 *
 * The trailing trim is not cosmetic: Windows and SMB drop trailing dots and
 * spaces silently, so a folder written as 'Gojira ' reads back as 'Gojira' and
 * every file inside it then looks like drift to the rebuild script.
 *
 * Leading dots are stripped for the same reason: a sanitised segment that keeps
 * a leading dot becomes hidden in a file browser, which defeats the purpose of
 * a human-readable archive.
 */
function slugSegment(text) {
  const cleaned = String(text ?? '')
    .replace(/^\.+/, '')
    .replace(ILLEGAL, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, MAX_SEGMENT)
    .replace(/[. ]+$/, '');
  // '.' and '..' name directories that already exist, so a show slugged out of
  // them would write into the archive's parent.
  return cleaned === '' || /^\.+$/.test(cleaned) ? '-' : cleaned;
}

function showFolderName({ date, city, headliner }) {
  const parts = [date, city, headliner].filter((p) => p != null && String(p).trim() !== '');
  const [d, ...rest] = parts;
  return rest.length ? `${slugSegment(d)} ${rest.map(slugSegment).join(' - ')}` : slugSegment(d);
}

function showFolderRelPath(userId, show) {
  return path.posix.join(slugSegment(userId), showFolderName(show));
}

/**
 * A name nothing in this folder has taken.
 *
 * The comparison is case-insensitive because the share is: allowing both
 * IMG_1.JPG and img_1.jpg would let the second upload overwrite the first.
 */
function uniqueFilename(taken, desired) {
  const lower = new Set(taken.map((n) => n.toLowerCase()));
  if (!lower.has(desired.toLowerCase())) return desired;

  const ext = path.extname(desired);
  const stem = desired.slice(0, desired.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * An absolute path inside the archive, or an error.
 *
 * rel_path normally comes from our own database, but the rebuild script writes
 * it from whatever it finds on disk, so this is the last line of defence rather
 * than the only one.
 */
function resolveArchivePath(relPath) {
  const root = archiveRoot();
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing a path outside the archive: ${relPath}`);
  }
  return resolved;
}

function thumbPath(sha256) {
  return path.join(thumbCacheRoot(), `${slugSegment(sha256)}.webp`);
}

/**
 * Where a video's poster frame lives.
 *
 * In the archive, not the cache, and this is the one asymmetry in the storage
 * layout. Photo thumbnails are derived from their originals and can always be
 * remade; a video poster comes from the browser that uploaded it, because
 * nothing on this server can decode video. Losing it means losing it.
 *
 * The leading dot keeps it out of a file browser's default view, so the show
 * folder still reads as the night's photographs.
 */
function posterPath(relPath) {
  const abs = resolveArchivePath(relPath);
  return path.join(path.dirname(abs), POSTERS_DIR, `${path.basename(abs)}.webp`);
}

/**
 * Where a video's web rendition lives.
 *
 * Beside the original like a poster, and hidden for the same reason: the show
 * folder should still read as the night's photographs in a file browser.
 *
 * Derived and therefore disposable — deleting `.web` costs only the CPU to make
 * it again, which is why it is not the archive copy and never replaces one.
 *
 * Named `<whole filename>.mp4`, so a 4K clip becomes `PXL_1.mp4.mp4`. The
 * doubled extension is deliberate and matches posterPath: uniqueFilename only
 * guarantees the FULL name is unique in a folder, so `clip.mov` and `clip.mp4`
 * can both be there, and keying on the stem alone would have one overwrite the
 * other's rendition.
 */
function webRenditionPath(absOriginal) {
  return path.join(path.dirname(absOriginal), WEB_DIR, `${path.basename(absOriginal)}.mp4`);
}

module.exports = {
  ARCHIVE_DIR, CACHE_DIR, DETACHED_DIR, MAX_SEGMENT, POSTERS_DIR, WEB_DIR,
  archiveRoot, thumbCacheRoot, slugSegment, showFolderName,
  showFolderRelPath, uniqueFilename, resolveArchivePath, thumbPath, posterPath,
  webRenditionPath,
};
