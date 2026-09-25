/**
 * EXIF, built byte for byte, so a test can bend one field of it.
 *
 * Shared by the parser's own unit tests and by the upload route's, which needs
 * a real JPEG carrying real EXIF because sharp runs unmocked there. Built rather
 * than committed as a binary: a fixture file cannot be asked for big-endian, a
 * missing pointer, or a stamp four years from its show.
 */

/**
 * A TIFF block holding IFD0 with only the Exif SubIFD pointer, that SubIFD, and
 * a value area its ASCII entries point into.
 *
 * @param {object} [options]
 * @param {string} [options.original] - DateTimeOriginal, `YYYY:MM:DD HH:MM:SS`.
 * @param {string} [options.digitized] - DateTimeDigitized, same shape.
 * @param {string} [options.offset] - OffsetTimeOriginal, e.g. `+02:00`.
 * @param {boolean} [options.little] - Byte order; false writes `MM`.
 * @param {boolean} [options.prefix] - Prepend the JPEG APP1 `Exif\0\0` marker.
 * @param {boolean} [options.pointer] - false writes a null SubIFD pointer.
 * @param {number} [options.pointerType] - TIFF type of the pointer entry.
 * @returns {Buffer}
 */
export function buildExif({
  original, digitized, offset,
  little = true, prefix = false, pointer = true, pointerType = 4,
} = {}) {
  const entries = [];
  if (original !== undefined) entries.push({ tag: 0x9003, text: original });
  if (digitized !== undefined) entries.push({ tag: 0x9004, text: digitized });
  if (offset !== undefined) entries.push({ tag: 0x9011, text: offset });

  const ifd0At = 8;
  const subAt = ifd0At + 2 + 12 + 4;
  const valuesAt = subAt + 2 + entries.length * 12 + 4;

  let cursor = valuesAt;
  for (const entry of entries) {
    // Every EXIF ASCII value carries its own NUL, and the count includes it.
    entry.bytes = Buffer.from(`${entry.text}\0`, 'latin1');
    // A value of four bytes or fewer lives INSIDE the entry, per the TIFF spec,
    // and only a longer one is stored out of line behind an offset. Getting
    // this wrong here rather than in the parser is how a short offset string
    // like "Z" came out as the four bytes of a pointer.
    entry.inline = entry.bytes.length <= 4;
    if (entry.inline) continue;
    entry.valueAt = cursor;
    cursor += entry.bytes.length;
  }

  const out = Buffer.alloc(cursor);
  const w16 = (at, v) => (little ? out.writeUInt16LE(v, at) : out.writeUInt16BE(v, at));
  const w32 = (at, v) => (little ? out.writeUInt32LE(v, at) : out.writeUInt32BE(v, at));

  out.write(little ? 'II' : 'MM', 0, 'latin1');
  w16(2, 42);
  w32(4, ifd0At);

  w16(ifd0At, 1);
  w16(ifd0At + 2, 0x8769);
  w16(ifd0At + 4, pointerType);
  w32(ifd0At + 6, 1);
  w32(ifd0At + 10, pointer ? subAt : 0);
  w32(ifd0At + 14, 0);

  w16(subAt, entries.length);
  entries.forEach((entry, i) => {
    const at = subAt + 2 + i * 12;
    w16(at, entry.tag);
    w16(at + 2, 2);
    w32(at + 4, entry.bytes.length);
    if (entry.inline) entry.bytes.copy(out, at + 8);
    else w32(at + 8, entry.valueAt);
  });
  w32(subAt + 2 + entries.length * 12, 0);

  entries.forEach((entry) => { if (!entry.inline) entry.bytes.copy(out, entry.valueAt); });

  return prefix ? Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), out]) : out;
}

/**
 * A JPEG carrying that EXIF, for a test that reads it back through sharp.
 *
 * The APP1 segment goes immediately after SOI, which is where a camera puts it
 * and where every reader looks. Its length field counts itself and the payload
 * but not the marker.
 *
 * @param {Buffer} baseJpeg - any valid JPEG, starting with SOI.
 * @param {Buffer} tiff - a block from buildExif(), without the prefix.
 * @returns {Buffer}
 */
export function jpegWithExif(baseJpeg, tiff) {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([
    baseJpeg.subarray(0, 2),
    header,
    payload,
    baseJpeg.subarray(2),
  ]);
}
