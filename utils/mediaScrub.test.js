import { describe, it, expect } from 'vitest';
import {
  planScrub, applyPatches, crc32,
} from './mediaScrub.js';
import { exifCapturedAt } from './exifCapturedAt.js';
import {
  jpegWithGpsTho894, buildExifWithGpsTho894, minimalJpegTho894, mp4WithLocationTho894, xmpApp1Tho894,
} from '../test/exifFixture.js';

// THO-894: what a stranger's copy of a file must not carry, cut out by
// same-length patches so nothing else moves.

const scrubbedTho894 = async (buf) => applyPatches(buf, await planScrub(buf));

const gpsCountTho894 = (buf, tiffAt, gpsIfd, little = true) => (little
  ? buf.readUInt16LE(tiffAt + gpsIfd)
  : buf.readUInt16BE(tiffAt + gpsIfd));

// The bytes of a JPEG from its first scan onwards — the picture itself.
const scanOfTho894 = (jpeg) => jpeg.subarray(jpeg.indexOf(Buffer.from([0xff, 0xda])));

function pngChunkTho894(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

const PNG_SIGNATURE_THO894 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR_THO894 = pngChunkTho894('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]));
const IDAT_THO894 = pngChunkTho894('IDAT', Buffer.from('78da63600000000200017e', 'hex'));
const IEND_THO894 = pngChunkTho894('IEND', Buffer.alloc(0));

function pngWithMetadataTho894() {
  const { tiff } = buildExifWithGpsTho894();
  return Buffer.concat([
    PNG_SIGNATURE_THO894, IHDR_THO894,
    pngChunkTho894('eXIf', tiff),
    pngChunkTho894('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>59,54.08N</x:xmpmeta>', 'latin1')),
    pngChunkTho894('tEXt', Buffer.from('Title\0Gojira, Oslo', 'latin1')),
    IDAT_THO894, IEND_THO894,
  ]);
}

function webpChunkTho894(fourcc, data) {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function webpWithMetadataTho894() {
  const { tiff } = buildExifWithGpsTho894();
  const body = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    webpChunkTho894('VP8X', Buffer.from([0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    webpChunkTho894('VP8L', Buffer.from('2f0000000700', 'hex')),
    webpChunkTho894('EXIF', tiff),
    webpChunkTho894('XMP ', Buffer.from('<x:xmpmeta>59,54.08N</x:xmpmeta>', 'latin1')),
  ]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

const containsTho894 = (buf, text) => buf.includes(Buffer.from(text, 'latin1'));

describe('planScrub on a JPEG', () => {
  it('empties the GPS IFD of a JPEG and leaves the picture bytes alone', async () => {
    const { jpeg, tiffAt, at } = jpegWithGpsTho894();
    expect(gpsCountTho894(jpeg, tiffAt, at.gpsIfd)).toBe(4);

    const out = await scrubbedTho894(jpeg);
    expect(out.length).toBe(jpeg.length);
    expect(gpsCountTho894(out, tiffAt, at.gpsIfd)).toBe(0);
    // The coordinates themselves, not just the entries pointing at them: the
    // RATIONALs live out of line and would otherwise still be in the file.
    expect(out.subarray(tiffAt + at.latitude, tiffAt + at.latitude + 24).equals(Buffer.alloc(24))).toBe(true);
    expect(scanOfTho894(out).equals(scanOfTho894(jpeg))).toBe(true);
  });

  it('reads a big-endian EXIF as carefully as a little-endian one', async () => {
    const { jpeg, tiffAt, at } = jpegWithGpsTho894(minimalJpegTho894, { little: false });
    const out = await scrubbedTho894(jpeg);
    expect(gpsCountTho894(out, tiffAt, at.gpsIfd, false)).toBe(0);
    expect(containsTho894(out, 'SN-1234567890')).toBe(false);
    expect(containsTho894(out, '2026:06:12 21:38:28')).toBe(true);
  });

  it('blanks the serial number and the maker note but keeps the orientation and capture time', async () => {
    const { jpeg, tiffAt, at } = jpegWithGpsTho894();
    const out = await scrubbedTho894(jpeg);
    for (const gone of ['SN-1234567890', 'maker-note-serial', 'Google', 'Pixel 8 Pro']) {
      expect(containsTho894(out, gone)).toBe(false);
    }
    expect(out.readUInt16LE(tiffAt + at.orientation)).toBe(6);
    // Read back through the same parser the upload uses, so "kept" means the
    // gallery still orders the photograph correctly.
    const exif = out.subarray(tiffAt);
    expect(exifCapturedAt(exif)).toEqual({ iso: '2026-06-12T19:38:28.000Z', zoned: true });
  });

  it('finds the EXIF of a second image after the first one\'s end, as a gain map carries it', async () => {
    const { jpeg } = jpegWithGpsTho894();
    const twice = Buffer.concat([jpeg, jpeg]);
    const out = await scrubbedTho894(twice);
    expect(containsTho894(out, 'SN-1234567890')).toBe(false);
    expect(out.length).toBe(twice.length);
  });
});

describe('planScrub on XMP', () => {
  it('blanks XMP in a JPEG, a PNG and a WebP', async () => {
    const { jpeg } = jpegWithGpsTho894(minimalJpegTho894, { xmp: true });
    for (const file of [jpeg, pngWithMetadataTho894(), webpWithMetadataTho894()]) {
      expect(containsTho894(file, '59,54.08N')).toBe(true);
      const out = await scrubbedTho894(file);
      expect(containsTho894(out, '59,54.08N')).toBe(false);
      expect(containsTho894(out, 'SN-1234567890')).toBe(false);
      expect(out.length).toBe(file.length);
      // And a scrubbed file has nothing left to scrub, which is how the
      // public copy checks its own work.
      expect(await planScrub(out)).toEqual([]);
    }
  });

  it('keeps an ordinary PNG text chunk, which is not metadata about the camera', async () => {
    const out = await scrubbedTho894(pngWithMetadataTho894());
    expect(containsTho894(out, 'Gojira, Oslo')).toBe(true);
  });
});

describe('planScrub on a PNG', () => {
  it('recomputes the CRC of a PNG chunk it changed', async () => {
    const out = await scrubbedTho894(pngWithMetadataTho894());
    let pos = 8;
    const seen = [];
    while (pos < out.length) {
      const length = out.readUInt32BE(pos);
      const type = out.toString('latin1', pos + 4, pos + 8);
      const crc = out.readUInt32BE(pos + 8 + length);
      expect(crc).toBe(crc32(out.subarray(pos + 4, pos + 8 + length)));
      seen.push(type);
      pos += 12 + length;
    }
    // The XMP chunk is renamed to a private ancillary type nothing reads.
    expect(seen).toEqual(['IHDR', 'eXIf', 'scRb', 'tEXt', 'IDAT', 'IEND']);
  });
});

describe('planScrub on an MP4', () => {
  it('neutralises ©xyz, loci and the Apple location key in an MP4 without moving a byte', async () => {
    const mp4 = mp4WithLocationTho894();
    const out = await scrubbedTho894(mp4);
    expect(out.length).toBe(mp4.length);
    for (const gone of ['+59.9139+010.7522', 'home\0', 'iPhone 15 Pro', 'Pixel 8', '59,54.08N', '\xa9xyz', 'loci']) {
      expect(containsTho894(out, gone)).toBe(false);
    }
    // What says nothing about where or with what stays: the title, the
    // software version, and every byte of the media.
    expect(containsTho894(out, 'Gig!')).toBe(true);
    expect(containsTho894(out, '18.1')).toBe(true);
    expect(containsTho894(out, 'frame-data-that-must-never-change'.repeat(4))).toBe(true);
    expect(await planScrub(out)).toEqual([]);
  });

  it('finds moov after a 64-bit mdat', async () => {
    const mp4 = mp4WithLocationTho894({ mdat64: true, moovAtEnd: true });
    const out = await scrubbedTho894(mp4);
    expect(containsTho894(out, '+59.9139+010.7522')).toBe(false);
  });

  it('reads an ISO FullBox meta as well as Apple\'s plain one', async () => {
    // Same file, with four bytes of version and flags put in front of meta's
    // first child and every enclosing size grown to match.
    const mp4 = mp4WithLocationTho894({ moovAtEnd: true });
    const metaAt = mp4.lastIndexOf(Buffer.from('meta', 'latin1')) - 4;
    const moovAt = mp4.lastIndexOf(Buffer.from('moov', 'latin1')) - 4;
    const grown = Buffer.concat([mp4.subarray(0, metaAt + 8), Buffer.alloc(4), mp4.subarray(metaAt + 8)]);
    grown.writeUInt32BE(grown.readUInt32BE(metaAt) + 4, metaAt);
    grown.writeUInt32BE(grown.readUInt32BE(moovAt) + 4, moovAt);
    const out = await scrubbedTho894(grown);
    expect(containsTho894(out, 'iPhone 15 Pro')).toBe(false);
  });

  it('refuses a compressed movie header it cannot look inside', async () => {
    const mp4 = mp4WithLocationTho894({ location: false, moovAtEnd: true });
    const at = mp4.indexOf(Buffer.from('mvhd', 'latin1'));
    mp4.write('cmov', at, 'latin1');
    await expect(planScrub(mp4)).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
  });
});

describe('planScrub refusing', () => {
  it('refuses a file it cannot parse rather than call it clean', async () => {
    const { jpeg, tiffAt, at } = jpegWithGpsTho894();
    // The GPS pointer sent past the end of its block: the coordinates can no
    // longer be found, so they cannot be said to be gone.
    const broken = Buffer.from(jpeg);
    const gpsEntry = tiffAt + 8 + 2 + 4 * 12;
    expect(broken.readUInt16LE(gpsEntry)).toBe(0x8825);
    broken.writeUInt32LE(0xfffff0, gpsEntry + 8);
    await expect(planScrub(broken)).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });

    // A truncated JPEG, and an MP4 whose box claims more than the file has.
    await expect(planScrub(jpeg.subarray(0, at.gpsIfd + tiffAt))).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
    const mp4 = mp4WithLocationTho894();
    mp4.writeUInt32BE(0x7fffffff, 0);
    await expect(planScrub(mp4)).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
  });

  it('refuses a format it does not know', async () => {
    await expect(planScrub(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'))).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
    await expect(planScrub(Buffer.from('master bytes'))).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
    await expect(planScrub(Buffer.alloc(0))).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
    // A HEIC opens like an MP4 and has no movie header: refused, not passed.
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypheic\0\0\0\0', 'latin1')]);
    await expect(planScrub(heic)).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
  });

  it('plans nothing for a file with no metadata', async () => {
    expect(await planScrub(minimalJpegTho894)).toEqual([]);
    expect(await planScrub(mp4WithLocationTho894({ location: false }))).toEqual([]);
    expect(await planScrub(Buffer.concat([PNG_SIGNATURE_THO894, IHDR_THO894, IDAT_THO894, IEND_THO894]))).toEqual([]);
  });

  it('leaves an APP1 it does not recognise alone', async () => {
    // Only the namespaces it knows are blanked; xmpApp1Tho894 is one of them.
    const other = Buffer.from(xmpApp1Tho894());
    other.write('http://example.com/other/1.0/', 4, 'latin1');
    const jpeg = Buffer.concat([minimalJpegTho894.subarray(0, 2), other, minimalJpegTho894.subarray(2)]);
    expect(await planScrub(jpeg)).toEqual([]);
  });
});
