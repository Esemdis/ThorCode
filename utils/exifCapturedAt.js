/**
 * When a photograph was taken, read out of its own EXIF.
 *
 * The sibling problem to `concert-map/src/utils/videoCapturedAt.js`, and solved
 * the same way and for the same reason: by hand, off the bytes, with no new
 * dependency. `sharp` is already here for thumbnails and hands back the raw
 * EXIF block; what it does not do is decode the tags, and one tag is all this
 * needs.
 *
 * `File.lastModified` is not an alternative. That was measured on a gig pulled
 * out of Google Photos: the mtime was the download time, and a parallel
 * download had reordered it, so the last photograph taken carried an earlier
 * stamp than the first. It fails as an absolute time and as a relative one,
 * and relative is the only thing a gallery's order needs.
 *
 * ## Timezones, which are the whole difficulty
 *
 * `DateTimeOriginal` is local wall-clock with no zone in it — a Pixel writes
 * `2026:06:12 21:38:28` for a photograph whose filename reads `19:38:28`,
 * because the filename is UTC and the venue was at +02:00. Stored naively that
 * is two hours early, and two hours inside a three-hour concert is enough to
 * sort an encore photograph ahead of a clip from the opener.
 *
 * So `OffsetTimeOriginal` is read alongside it and applied when it is there,
 * which on any phone new enough to write EXIF 2.31 it is. When it is absent the
 * time is taken as UTC and may be out by the venue's offset. That is a constant
 * shift per device per night, so it never reorders that camera's own
 * photographs — it can only misplace them against another device's, and
 * `capturedAtFor`'s window around the show still throws out anything wild.
 */

// A TIFF header is "II"/"MM", 42, then the offset to IFD0 — 8 bytes, and every
// offset inside the block is measured from its first byte.
const TIFF_HEADER_BYTES = 8;

// JPEG carries EXIF in an APP1 segment that begins with this. Some callers hand
// it over intact and some strip it, so it is skipped when present rather than
// required or assumed absent.
const APP1_PREFIX = 'Exif\0\0';

const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_DATE_TIME_DIGITIZED = 0x9004;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;

// Bytes per component, by TIFF type code. Only ASCII and LONG matter here; the
// rest are present so an entry's length can be measured well enough to skip it.
const TYPE_BYTES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

const ENTRY_BYTES = 12;

// A real IFD holds a few dozen entries. A corrupt count field is the difference
// between a bounded read and one that walks off into the image data.
const MAX_ENTRIES = 512;

/** `Exif\0\0` skipped, when it is there. */
function tiffStart(buf) {
  return buf.length >= APP1_PREFIX.length
    && buf.toString('latin1', 0, APP1_PREFIX.length) === APP1_PREFIX
    ? APP1_PREFIX.length
    : 0;
}

/**
 * Byte order and the first directory, or null when this is not a TIFF block.
 */
function readHeader(buf, start) {
  if (buf.length < start + TIFF_HEADER_BYTES) return null;
  const order = buf.toString('latin1', start, start + 2);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  const magic = little ? buf.readUInt16LE(start + 2) : buf.readUInt16BE(start + 2);
  if (magic !== 42) return null;
  const ifd0 = little ? buf.readUInt32LE(start + 4) : buf.readUInt32BE(start + 4);
  return { little, ifd0 };
}

const u16 = (buf, at, little) => (little ? buf.readUInt16LE(at) : buf.readUInt16BE(at));
const u32 = (buf, at, little) => (little ? buf.readUInt32LE(at) : buf.readUInt32BE(at));

/**
 * Every entry of one directory, as a map of tag to `{type, count, valueAt}`.
 *
 * `valueAt` is where the value actually lives: inline in the entry when it fits
 * in four bytes, and at an offset from the start of the TIFF block when it does
 * not. A 20-character date never fits, so it is always the latter — but the
 * distinction has to be made or the offset is read as though it were text.
 */
function readDirectory(buf, start, at, little) {
  const base = start + at;
  if (at <= 0 || base + 2 > buf.length) return null;

  const count = u16(buf, base, little);
  if (count === 0 || count > MAX_ENTRIES) return null;
  if (base + 2 + count * ENTRY_BYTES > buf.length) return null;

  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    const entry = base + 2 + i * ENTRY_BYTES;
    const tag = u16(buf, entry, little);
    const type = u16(buf, entry + 2, little);
    const components = u32(buf, entry + 4, little);
    const width = TYPE_BYTES[type];
    if (!width) continue;
    const bytes = width * components;
    const inline = bytes <= 4;
    const valueAt = inline ? entry + 8 : start + u32(buf, entry + 8, little);
    if (!inline && (valueAt < start || valueAt + bytes > buf.length)) continue;
    entries.set(tag, { type, count: components, valueAt, bytes });
  }
  return entries;
}

/** An ASCII entry's text, trimmed of its terminator and any padding. */
function asciiValue(buf, entry) {
  if (!entry || entry.type !== 2) return null;
  const text = buf.toString('latin1', entry.valueAt, entry.valueAt + entry.bytes);
  const trimmed = text.replace(/\0.*$/s, '').trim();
  return trimmed || null;
}

/**
 * `2026:06:12 21:38:28` as the date part of an ISO string, or null.
 *
 * EXIF's own zeroed placeholder (`0000:00:00 00:00:00`) is a real value written
 * by real cameras and reads as a date if it is not refused here.
 */
function isoLocalPart(exifDate) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(exifDate ?? ''));
  if (!m) return null;
  const [, year, month, day, hour, minute, second] = m;
  if (year === '0000' || month === '00' || day === '00') return null;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

/** `+02:00`, `-0530` or `Z` as a suffix Date.parse understands, else null. */
function isoOffsetPart(offsetTime) {
  const text = String(offsetTime ?? '').trim();
  if (!text) return null;
  if (/^Z$/i.test(text)) return 'Z';
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(text);
  if (!m) return null;
  const [, sign, hours, minutes] = m;
  if (Number(hours) > 14 || Number(minutes) > 59) return null;
  return `${sign}${hours}:${minutes}`;
}

/**
 * The instant a photograph was taken, from its raw EXIF block.
 *
 * @param {Buffer|Uint8Array|null} exif - `sharp(...).metadata().exif`, with or
 *   without its `Exif\0\0` prefix.
 * @returns {{iso: string, zoned: boolean}|null}
 *   `zoned` says whether an offset was found and applied. False means the time
 *   was read as UTC and may be out by the venue's offset — worth knowing, and
 *   worth not pretending otherwise.
 */
function exifCapturedAt(exif) {
  if (!exif || typeof exif.length !== 'number' || exif.length < TIFF_HEADER_BYTES) return null;
  const buf = Buffer.isBuffer(exif) ? exif : Buffer.from(exif);

  const start = tiffStart(buf);
  const header = readHeader(buf, start);
  if (!header) return null;
  const { little, ifd0 } = header;

  const root = readDirectory(buf, start, ifd0, little);
  if (!root) return null;

  // The capture tags live in the Exif SubIFD, which IFD0 only points at. A
  // photograph with no pointer has no DateTimeOriginal to find.
  const pointer = root.get(TAG_EXIF_IFD_POINTER);
  if (!pointer || pointer.type !== 4) return null;
  const sub = readDirectory(buf, start, u32(buf, pointer.valueAt, little), little);
  if (!sub) return null;

  // Digitized is the fallback rather than IFD0's DateTime: for a camera the two
  // capture tags are the same instant, while DateTime means "last changed" and
  // is exactly the kind of modification stamp this whole file exists to avoid.
  const local = isoLocalPart(asciiValue(buf, sub.get(TAG_DATE_TIME_ORIGINAL)))
    ?? isoLocalPart(asciiValue(buf, sub.get(TAG_DATE_TIME_DIGITIZED)));
  if (!local) return null;

  const offset = isoOffsetPart(asciiValue(buf, sub.get(TAG_OFFSET_TIME_ORIGINAL)));
  const parsed = Date.parse(`${local}${offset ?? 'Z'}`);
  if (!Number.isFinite(parsed)) return null;

  return { iso: new Date(parsed).toISOString(), zoned: Boolean(offset) };
}

/**
 * The same, read off a file on disk.
 *
 * `sharp` is already a dependency for thumbnails and its `metadata()` reads
 * only the header, so this costs a header parse rather than a decode even on a
 * 40 MP original.
 *
 * Never throws. A photograph whose EXIF cannot be read still uploads and
 * behaves exactly as every file already in the archive does — taking a batch
 * down over one file's metadata would be far worse than filing it without a
 * time.
 *
 * @param {string} absPath
 * @returns {Promise<{iso: string, zoned: boolean}|null>}
 */
async function exifCapturedAtOfFile(absPath) {
  try {
    // Required here rather than at module load so the parser above can be
    // tested, and used, without pulling in a native dependency.
    const sharp = require('sharp');
    const { exif } = await sharp(absPath).metadata();
    return exifCapturedAt(exif);
  } catch {
    return null;
  }
}

module.exports = { exifCapturedAt, exifCapturedAtOfFile, APP1_PREFIX };
