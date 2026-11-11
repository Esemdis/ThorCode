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

/**
 * A 1×1 baseline JPEG with no metadata at all: SOI, JFIF, tables, one scan,
 * EOI. The base the THO-894 fixtures add EXIF and XMP to.
 */
export const minimalJpegTho894 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64',
);

const ascii = (text) => Buffer.from(`${text}\0`, 'latin1');

/**
 * A TIFF block with everything a phone writes that THO-894 has to remove,
 * beside what it has to keep: Make, Model and Orientation in IFD0; the capture
 * time, its offset, a body serial, a lens model and a maker note in the Exif
 * SubIFD; and a GPS IFD whose coordinates are RATIONALs stored out of line, as
 * they always are.
 *
 * @param {{little?: boolean}} [options]
 * @returns {{tiff: Buffer, at: object}} `at` holds offsets inside `tiff` a test
 *   can read back: the GPS IFD, the serial's value, the latitude's value, the
 *   capture time's value and the orientation entry.
 */
export function buildExifWithGpsTho894({ little = true } = {}) {
  const rational = (...pairs) => {
    const b = Buffer.alloc(pairs.length * 4);
    pairs.forEach((v, i) => (little ? b.writeUInt32LE(v, i * 4) : b.writeUInt32BE(v, i * 4)));
    return b;
  };
  const short = (v) => { const b = Buffer.alloc(2); if (little) b.writeUInt16LE(v); else b.writeUInt16BE(v); return b; };
  const ifds = [
    [
      { tag: 0x010f, type: 2, value: ascii('Google') },
      { tag: 0x0110, type: 2, value: ascii('Pixel 8 Pro') },
      { tag: 0x0112, type: 3, value: short(6), name: 'orientation' },
      { tag: 0x8769, type: 4, pointer: 1 },
      { tag: 0x8825, type: 4, pointer: 2 },
    ],
    [
      { tag: 0x9003, type: 2, value: ascii('2026:06:12 21:38:28'), name: 'original' },
      { tag: 0x9011, type: 2, value: ascii('+02:00') },
      { tag: 0x927c, type: 7, value: Buffer.from('Google\0maker-note-serial-XYZ', 'latin1') },
      { tag: 0xa431, type: 2, value: ascii('SN-1234567890'), name: 'serial' },
      { tag: 0xa434, type: 2, value: ascii('Pixel 8 Pro back camera') },
    ],
    [
      { tag: 0x0001, type: 2, value: ascii('N') },
      { tag: 0x0002, type: 5, value: rational(59, 1, 54, 1, 5004, 100), name: 'latitude' },
      { tag: 0x0003, type: 2, value: ascii('E') },
      { tag: 0x0004, type: 5, value: rational(10, 1, 45, 1, 720, 100) },
    ],
  ];

  const dirAt = [];
  let cursor = 8;
  for (const entries of ifds) { dirAt.push(cursor); cursor += 2 + entries.length * 12 + 4; }
  for (const entries of ifds) {
    for (const e of entries) {
      if (e.value && e.value.length > 4) { e.valueAt = cursor; cursor += e.value.length + (e.value.length & 1); }
    }
  }

  const out = Buffer.alloc(cursor);
  const w16 = (at, v) => (little ? out.writeUInt16LE(v, at) : out.writeUInt16BE(v, at));
  const w32 = (at, v) => (little ? out.writeUInt32LE(v, at) : out.writeUInt32BE(v, at));
  out.write(little ? 'II' : 'MM', 0, 'latin1');
  w16(2, 42);
  w32(4, dirAt[0]);

  const at = { gpsIfd: dirAt[2] };
  ifds.forEach((entries, d) => {
    w16(dirAt[d], entries.length);
    entries.forEach((e, i) => {
      const entry = dirAt[d] + 2 + i * 12;
      w16(entry, e.tag);
      w16(entry + 2, e.type);
      if (e.pointer !== undefined) {
        w32(entry + 4, 1);
        w32(entry + 8, dirAt[e.pointer]);
        return;
      }
      const width = { 2: 1, 3: 2, 5: 8, 7: 1 }[e.type];
      w32(entry + 4, e.value.length / width);
      if (e.valueAt === undefined) e.value.copy(out, entry + 8);
      else { w32(entry + 8, e.valueAt); e.value.copy(out, e.valueAt); }
      if (e.name) at[e.name] = e.valueAt ?? entry + 8;
    });
    w32(dirAt[d] + 2 + entries.length * 12, 0);
  });
  return { tiff: out, at };
}

/** An XMP APP1 segment whose packet names a place, as Lightroom writes one. */
export function xmpApp1Tho894() {
  const payload = Buffer.from(
    'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><exif:GPSLatitude>59,54.08N</exif:GPSLatitude></x:xmpmeta>',
    'latin1',
  );
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/**
 * A JPEG carrying buildExifWithGpsTho894's EXIF (and, when asked, an XMP
 * segment), with where its TIFF block starts.
 *
 * @param {Buffer} [baseJpeg]
 * @param {{little?: boolean, xmp?: boolean}} [options]
 * @returns {{jpeg: Buffer, tiffAt: number, at: object}}
 */
export function jpegWithGpsTho894(baseJpeg = minimalJpegTho894, { little = true, xmp = false } = {}) {
  const { tiff, at } = buildExifWithGpsTho894({ little });
  let jpeg = jpegWithExif(baseJpeg, tiff);
  if (xmp) jpeg = Buffer.concat([jpeg.subarray(0, 2), xmpApp1Tho894(), jpeg.subarray(2)]);
  const tiffAt = jpeg.indexOf('Exif\0\0', 0, 'latin1') + 6;
  return { jpeg, tiffAt, at };
}

const mp4Box = (type, ...parts) => {
  const payload = Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : p)));
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
};

const u32Tho894 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };

/**
 * An MP4 shaped like a phone's, with the location stored every way phones
 * store it: Android's ©xyz in moov/udta, 3GPP's loci, ©mak and ©mod, an XMP
 * uuid box at the top level, and Apple's mdta keys (location, make, model —
 * and software, which stays) in a plain, non-FullBox `meta`.
 *
 * @param {object} [options]
 * @param {boolean} [options.location] - false leaves every one of them out.
 * @param {boolean} [options.mdat64] - write mdat with a 64-bit size.
 * @param {boolean} [options.moovAtEnd] - moov after mdat, as a phone writes it.
 * @returns {Buffer}
 */
export function mp4WithLocationTho894({ location = true, mdat64 = false, moovAtEnd = true } = {}) {
  const ftyp = mp4Box('ftyp', 'isom', u32Tho894(0x200), 'isommp42');
  const media = Buffer.from('frame-data-that-must-never-change'.repeat(4), 'latin1');
  let mdat;
  if (mdat64) {
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1, 0);
    header.write('mdat', 4, 'latin1');
    header.writeBigUInt64BE(BigInt(media.length + 16), 8);
    mdat = Buffer.concat([header, media]);
  } else {
    mdat = mp4Box('mdat', media);
  }
  const mvhd = mp4Box('mvhd', Buffer.alloc(100));
  const tkhd = mp4Box('tkhd', Buffer.alloc(84));
  const appleKey = (name) => Buffer.concat([u32Tho894(name.length + 8), Buffer.from('mdta', 'latin1'), Buffer.from(name, 'latin1')]);
  const keyNames = [
    'com.apple.quicktime.location.ISO6709', 'com.apple.quicktime.make',
    'com.apple.quicktime.model', 'com.apple.quicktime.software',
  ];
  const values = ['+59.9139+010.7522+012.000/', 'Apple', 'iPhone 15 Pro', '18.1'];
  const ilstItem = (index, value) => {
    const b = mp4Box('xxxx', mp4Box('data', u32Tho894(1), u32Tho894(0), value));
    b.writeUInt32BE(index, 4);
    return b;
  };
  const appleMeta = mp4Box(
    'meta',
    mp4Box('hdlr', u32Tho894(0), u32Tho894(0), 'mdta', Buffer.alloc(12), '\0'),
    mp4Box('keys', u32Tho894(0), u32Tho894(keyNames.length), ...keyNames.map(appleKey)),
    mp4Box('ilst', ...values.map((v, i) => ilstItem(i + 1, v))),
  );
  const udta = location
    ? mp4Box(
      'udta',
      mp4Box('\xa9xyz', Buffer.from([0, 18, 0x15, 0xc7]), '+59.9139+010.7522/'),
      mp4Box('loci', u32Tho894(0), Buffer.from([0x15, 0xc7]), 'home\0', Buffer.alloc(13)),
      mp4Box('\xa9mak', Buffer.from([0, 6, 0x15, 0xc7]), 'Google'),
      mp4Box('\xa9mod', Buffer.from([0, 7, 0x15, 0xc7]), 'Pixel 8'),
      mp4Box('\xa9nam', Buffer.from([0, 4, 0x15, 0xc7]), 'Gig!'),
    )
    : mp4Box('udta', mp4Box('\xa9nam', Buffer.from([0, 4, 0x15, 0xc7]), 'Gig!'));
  const moov = mp4Box('moov', mvhd, mp4Box('trak', tkhd), udta, ...(location ? [appleMeta] : []));
  const xmp = location
    ? [mp4Box('uuid', Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex'), '<x:xmpmeta>59,54.08N</x:xmpmeta>')]
    : [];
  return Buffer.concat(moovAtEnd ? [ftyp, ...xmp, mdat, moov] : [ftyp, moov, ...xmp, mdat]);
}
