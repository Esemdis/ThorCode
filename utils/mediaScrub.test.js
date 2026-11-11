import { describe, it, expect } from 'vitest';
import {
  planScrub, applyPatches, crc32, planSource,
} from './mediaScrub.js';
import { exifCapturedAt } from './exifCapturedAt.js';
import {
  jpegWithGpsTho894, buildExifWithGpsTho894, minimalJpegTho894, mp4WithLocationTho894, xmpApp1Tho894,
  jpegWithExif, tiffFromIfdsTho894Review, mp4BoxTho894Review,
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

  it('neutralises the Apple lens make and model, which name the phone as plainly as its model does', async () => {
    // An iPhone writes `com.apple.quicktime.camera.lens_model` ("iPhone 15 Pro
    // back triple camera …"). The key ends in `_model`, not `.model`, so a
    // match anchored on the dot let it through a public share link (THO-900).
    const mp4 = mp4WithLocationTho894({
      extraAppleKeysTho900: [
        ['com.apple.quicktime.camera.lens_model', 'Lens: iPhone 15 Pro back triple camera 6.765mm f/1.78'],
        ['com.apple.quicktime.camera.lens_make', 'LensMaker-Apple'],
      ],
    });
    const out = await scrubbedTho894(mp4);
    expect(out.length).toBe(mp4.length);
    expect(containsTho894(out, 'back triple camera')).toBe(false);
    expect(containsTho894(out, 'LensMaker-Apple')).toBe(false);
    expect(containsTho894(out, '18.1')).toBe(true);
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

// ---------------------------------------------------------------------------
// The THO-894 review fixes: owner names beyond the ticket's list, places the
// first walk did not look, and limits that turn a hostile file into a refusal.

const asciiTho894Review = (text) => Buffer.from(`${text}\0`, 'latin1');
const shortTho894Review = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32Tho894Review = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };

describe('planScrub after the THO-894 review', () => {
  it('blanks the copyright, the host computer, the Windows author and an XMP or IPTC tag inside EXIF', async () => {
    const { tiff } = tiffFromIfdsTho894Review([[
      { tag: 0x0112, type: 3, value: shortTho894Review(6) },
      { tag: 0x013c, type: 2, value: asciiTho894Review('HostComputer-iPhone 15 Pro') },
      { tag: 0x02bc, type: 1, value: Buffer.from('<x:xmpmeta>XMP-in-TIFF 59,54.08N</x:xmpmeta>', 'latin1') },
      { tag: 0x8298, type: 2, value: asciiTho894Review('Copyright Owner-Name') },
      { tag: 0x83bb, type: 7, value: Buffer.from('IPTC-City-Oslo-Grunerlokka', 'latin1') },
      { tag: 0x9c9d, type: 1, value: Buffer.from('XPAuthor-Name\0', 'utf16le') },
    ]]);
    const jpeg = jpegWithExif(minimalJpegTho894, tiff);
    const out = await scrubbedTho894(jpeg);
    for (const gone of ['HostComputer-iPhone', 'XMP-in-TIFF', 'Owner-Name', 'IPTC-City']) {
      expect(containsTho894(out, gone)).toBe(false);
    }
    expect(out.includes(Buffer.from('XPAuthor', 'utf16le'))).toBe(false);
    // Orientation is the one thing in that directory a viewer needs.
    expect(out.includes(Buffer.from([0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00]))).toBe(true);
    expect(await planScrub(out)).toEqual([]);
  });

  it('empties a GPS directory that the second IFD points at, not only one the first does', async () => {
    const latitude = Buffer.alloc(24, 0x11);
    const { tiff, dirAt } = tiffFromIfdsTho894Review([
      [{ tag: 0x0112, type: 3, value: shortTho894Review(1) }],
      [{ tag: 0x8825, type: 4, pointer: 2 }],
      [{ tag: 0x0002, type: 5, value: latitude }],
    ], { next: { 0: 1 } });
    const jpeg = jpegWithExif(minimalJpegTho894, tiff);
    const tiffAt = jpeg.indexOf('Exif\0\0', 0, 'latin1') + 6;
    const out = await scrubbedTho894(jpeg);
    expect(out.readUInt16LE(tiffAt + dirAt[2])).toBe(0);
    expect(out.includes(latitude)).toBe(false);
  });

  it('treats a PNG Author or Copyright like the EXIF owner fields, and an IPTC raw profile like XMP', async () => {
    const png = Buffer.concat([
      PNG_SIGNATURE_THO894, IHDR_THO894,
      pngChunkTho894('tEXt', Buffer.from('Author\0PNG-Author-Name', 'latin1')),
      pngChunkTho894('iTXt', Buffer.from('Copyright\0\0\0\0\0PNG-Copyright-Name', 'latin1')),
      pngChunkTho894('tEXt', Buffer.from('Raw profile type iptc\0\niptc\n 4\n4f736c6f\n', 'latin1')),
      pngChunkTho894('tEXt', Buffer.from('Title\0Gojira, Oslo', 'latin1')),
      IDAT_THO894, IEND_THO894,
    ]);
    const out = await scrubbedTho894(png);
    for (const gone of ['PNG-Author-Name', 'PNG-Copyright-Name', '4f736c6f']) {
      expect(containsTho894(out, gone)).toBe(false);
    }
    expect(containsTho894(out, 'Gojira, Oslo')).toBe(true);
    expect(await planScrub(out)).toEqual([]);
  });

  it('neutralises the author and the copyright in an MP4, and Android\'s manufacturer key', async () => {
    const mp4 = mp4WithLocationTho894({
      extraUdtaTho894Review: [
        ['\xa9aut', 'udta-aut-Owner'], ['\xa9ART', 'udta-ART-Owner'], ['auth', 'udta-auth-Owner'],
        ['\xa9cpy', 'udta-cpy-Owner'], ['cprt', 'udta-cprt-Owner'],
      ],
      extraAppleKeysTho900: [
        ['com.apple.quicktime.author', 'mdta-author-Owner'],
        ['com.apple.quicktime.artist', 'mdta-artist-Owner'],
        ['com.apple.quicktime.copyright', 'mdta-copyright-Owner'],
        ['com.android.manufacturer', 'mdta-manufacturer-Samsung'],
      ],
    });
    const out = await scrubbedTho894(mp4);
    expect(out.length).toBe(mp4.length);
    for (const gone of ['udta-aut', 'udta-ART', 'udta-auth', 'udta-cpy', 'udta-cprt',
      'mdta-author', 'mdta-artist', 'mdta-copyright', 'mdta-manufacturer']) {
      expect(containsTho894(out, gone)).toBe(false);
    }
    expect(containsTho894(out, 'Gig!')).toBe(true);
    expect(containsTho894(out, '18.1')).toBe(true);
    expect(await planScrub(out)).toEqual([]);
  });

  it('searches a file-level meta and a movie fragment the way it searches moov', async () => {
    const box = mp4BoxTho894Review;
    const key = (name) => Buffer.concat([u32Tho894Review(name.length + 8), Buffer.from('mdta', 'latin1'), Buffer.from(name, 'latin1')]);
    const item = box('xxxx', box('data', u32Tho894Review(1), u32Tho894Review(0), 'file-meta +48.85+002.35/'));
    item.writeUInt32BE(1, 4);
    const fileMeta = box(
      'meta',
      u32Tho894Review(0),
      box('hdlr', u32Tho894Review(0), u32Tho894Review(0), 'mdta', Buffer.alloc(12), '\0'),
      box('keys', u32Tho894Review(0), u32Tho894Review(1), key('com.apple.quicktime.location.ISO6709')),
      box('ilst', item),
    );
    const moof = box(
      'moof',
      box('mfhd', Buffer.alloc(8)),
      box('traf', box('udta', box('\xa9xyz', Buffer.from([0, 18, 0x15, 0xc7]), 'fragment +51.50-000.12/'))),
    );
    const mp4 = mp4WithLocationTho894({ location: false, topLevelTho894Review: [fileMeta, moof] });
    const out = await scrubbedTho894(mp4);
    expect(containsTho894(out, 'file-meta +48.85')).toBe(false);
    expect(containsTho894(out, 'fragment +51.50')).toBe(false);
    expect(out.length).toBe(mp4.length);
    expect(await planScrub(out)).toEqual([]);
  });

  it('refuses a file-level meta whose items live somewhere it does not read', async () => {
    // An `iloc` points at item data (an Exif item, say) elsewhere in the file,
    // usually in mdat, which is never read: "nothing found" would be a guess.
    const box = mp4BoxTho894Review;
    const fileMeta = box(
      'meta',
      u32Tho894Review(0),
      box('hdlr', u32Tho894Review(0), u32Tho894Review(0), 'pict', Buffer.alloc(12), '\0'),
      box('iloc', Buffer.alloc(8)),
    );
    const mp4 = mp4WithLocationTho894({ location: false, topLevelTho894Review: [fileMeta] });
    await expect(planScrub(mp4)).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
  });

  it('refuses an EXIF chain longer than any camera writes, rather than walk it', async () => {
    // A WebP or PNG EXIF chunk is not capped at 64 KB as a JPEG APP1 is: a
    // chain of sixteen million empty IFDs held the event loop for seconds.
    const ifds = Array.from({ length: 40 }, () => []);
    const next = Object.fromEntries(ifds.slice(1).map((_, i) => [i, i + 1]));
    const { tiff } = tiffFromIfdsTho894Review(ifds, { next });
    await expect(planScrub(jpegWithExif(minimalJpegTho894, tiff))).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
  });

  it('refuses an EXIF block that asks for more blanking than the file holds', async () => {
    // Five hundred Make entries all pointing at one value: each would have been
    // its own zeroed copy, which at 256 MB is the whole heap many times over.
    const value = Buffer.alloc(4096, 0x41);
    const shared = { tag: 0x010f, type: 2, value };
    const { tiff, valueAt } = tiffFromIfdsTho894Review([[shared]]);
    const many = Buffer.alloc(tiff.length + 500 * 12);
    tiff.copy(many);
    // Rewrite IFD0 as 500 copies of the entry, values after them.
    const dir = 8;
    many.writeUInt16LE(500, dir);
    const valuesAt = dir + 2 + 500 * 12 + 4;
    for (let i = 0; i < 500; i += 1) {
      const entry = dir + 2 + i * 12;
      many.writeUInt16LE(0x010f, entry);
      many.writeUInt16LE(2, entry + 2);
      many.writeUInt32LE(value.length, entry + 4);
      many.writeUInt32LE(valuesAt, entry + 8);
    }
    many.writeUInt32LE(0, dir + 2 + 500 * 12);
    value.copy(many, valuesAt);
    expect(valueAt.size).toBe(1);
    const block = many.subarray(0, valuesAt + value.length);
    await expect(planScrub(jpegWithExif(minimalJpegTho894, block))).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
  });

  it('refuses more patches than any real file needs', async () => {
    // Two million empty ©xyz boxes made two million patches and 356 MB of heap.
    const xyz = mp4BoxTho894Review('\xa9xyz', 'x');
    const many = mp4BoxTho894Review('udta', Buffer.concat(Array.from({ length: 6000 }, () => xyz)));
    const mp4 = mp4WithLocationTho894({ location: false, extraUdtaTho894Review: [] });
    const moovAt = mp4.lastIndexOf(Buffer.from('moov', 'latin1')) - 4;
    const grown = Buffer.concat([mp4.subarray(0, moovAt + 8), many, mp4.subarray(moovAt + 8)]);
    grown.writeUInt32BE(grown.readUInt32BE(moovAt) + many.length, moovAt);
    await expect(planScrub(grown)).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
  });

  it('refuses boxes nested deeper than any MP4 nests them, as a refusal rather than a crash', async () => {
    // 100,000 nested udta boxes overflowed the stack: a RangeError and a 500
    // where every other refusal is a quiet 404.
    const depth = 100000;
    const nest = Buffer.alloc(depth * 8);
    for (let i = 0; i < depth; i += 1) {
      nest.writeUInt32BE((depth - i) * 8, i * 8);
      nest.write('udta', i * 8 + 4, 'latin1');
    }
    const mp4 = mp4WithLocationTho894({ location: false });
    const moovAt = mp4.lastIndexOf(Buffer.from('moov', 'latin1')) - 4;
    const grown = Buffer.concat([mp4.subarray(0, moovAt + 8), nest, mp4.subarray(moovAt + 8)]);
    grown.writeUInt32BE(grown.readUInt32BE(moovAt) + nest.length, moovAt);
    await expect(planScrub(grown)).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
  });

  it('refuses a JPEG that carries more images than any phone appends', async () => {
    const many = Buffer.concat(Array.from({ length: 100 }, () => minimalJpegTho894));
    await expect(planScrub(many)).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
  });
});

// ---------------------------------------------------------------------------
// Round 2 of the THO-894 review: a box budget so a file of millions of tiny
// boxes is a cheap refusal, not a heap OOM or an hour of reads; and the last
// identifying keys and manifests.

const tinyBoxesTho894Round2 = (count, type = 'zzzz') => {
  const b = Buffer.alloc(count * 8);
  for (let i = 0; i < count; i += 1) {
    b.writeUInt32BE(8, i * 8);
    b.write(type, i * 8 + 4, 'latin1');
  }
  return b;
};

// A source over a buffer that counts its reads, as planScrubFile's does off disk.
const countingSourceTho894Round2 = (buf) => {
  const source = {
    size: buf.length,
    reads: 0,
    read: async (offset, length) => { source.reads += 1; return buf.subarray(offset, offset + length); },
  };
  return source;
};

describe('planScrub after the THO-894 review, round 2', () => {
  it('refuses a meta with more boxes than any real file holds, without collecting them first', async () => {
    // 31M empty children of one meta were 31M objects in an array and a heap
    // OOM that took the whole API down: not an exception, so no 404 either.
    const box = mp4BoxTho894Review;
    const meta = box('meta', u32Tho894Review(0), box('hdlr', u32Tho894Review(0), u32Tho894Review(0), 'mdir', Buffer.alloc(12)),
      tinyBoxesTho894Round2(300000));
    const mp4 = Buffer.concat([box('ftyp', 'isom', u32Tho894Review(0x200), 'isommp42'), box('moov', box('mvhd', Buffer.alloc(100)), meta)]);
    await expect(planScrub(mp4)).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
  });

  it('refuses a moov of more boxes than any real file holds', async () => {
    const box = mp4BoxTho894Review;
    const mp4 = Buffer.concat([box('ftyp', 'isom', u32Tho894Review(0x200), 'isommp42'),
      box('moov', box('mvhd', Buffer.alloc(100)), tinyBoxesTho894Round2(300000))]);
    await expect(planScrub(mp4)).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
  });

  it('refuses an Apple keys box with more entries than any real file holds', async () => {
    const box = mp4BoxTho894Review;
    const meta = box('meta', box('hdlr', u32Tho894Review(0), u32Tho894Review(0), 'mdta', Buffer.alloc(12)),
      box('keys', u32Tho894Review(0), u32Tho894Review(300000), tinyBoxesTho894Round2(300000, 'mdta')), box('ilst'));
    const mp4 = Buffer.concat([box('ftyp', 'isom', u32Tho894Review(0x200), 'isommp42'), box('moov', box('mvhd', Buffer.alloc(100)), meta)]);
    await expect(planScrub(mp4)).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
  });

  it('reads an MP4\'s top-level box headers a window at a time, not one read per box', async () => {
    // One read per box was 36 s for a million top-level boxes off disk.
    const box = mp4BoxTho894Review;
    const mp4 = Buffer.concat([box('ftyp', 'isom', u32Tho894Review(0x200), 'isommp42'),
      tinyBoxesTho894Round2(5000, 'free'), box('moov', box('mvhd', Buffer.alloc(100)))]);
    const source = countingSourceTho894Round2(mp4);
    expect(await planSource(source)).toEqual([]);
    expect(source.reads).toBeLessThan(10);
  });

  it('refuses a top level of more boxes than any recording has', async () => {
    const box = mp4BoxTho894Review;
    const mp4 = Buffer.concat([box('ftyp', 'isom', u32Tho894Review(0x200), 'isommp42'),
      tinyBoxesTho894Round2(300000, 'free'), box('moov', box('mvhd', Buffer.alloc(100)))]);
    const source = countingSourceTho894Round2(mp4);
    await expect(planSource(source)).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
    expect(source.reads).toBeLessThan(100);
  });

  it('refuses an image of more chunks or segments than any encoder writes', async () => {
    const pngChunks = Buffer.alloc(1100000 * 12);
    for (let i = 0; i < 1100000; i += 1) pngChunks.write('abCd', i * 12 + 4, 'latin1');
    const png = Buffer.concat([PNG_SIGNATURE_THO894, IHDR_THO894, pngChunks, IDAT_THO894, IEND_THO894]);
    await expect(planScrub(png)).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });

    const comments = Buffer.alloc(1100000 * 4);
    for (let i = 0; i < 1100000; i += 1) comments.writeUInt32BE(0xfffe0002, i * 4);
    const jpeg = Buffer.concat([minimalJpegTho894.subarray(0, 2), comments, minimalJpegTho894.subarray(2)]);
    await expect(planScrub(jpeg)).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });

    const body = Buffer.alloc(4 + 1100000 * 8);
    body.write('WEBP', 0, 'latin1');
    for (let i = 0; i < 1100000; i += 1) body.write('abcd', 4 + i * 8, 'latin1');
    const head = Buffer.alloc(8);
    head.write('RIFF', 0, 'latin1');
    head.writeUInt32LE(body.length, 4);
    await expect(planScrub(Buffer.concat([head, body]))).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
  });

  it('neutralises Apple\'s content identifier, the video\'s ImageUniqueID', async () => {
    const mp4 = mp4WithLocationTho894({
      extraAppleKeysTho900: [['com.apple.quicktime.content.identifier', 'E1F3A6C2-LIVE-PHOTO-PAIR']],
    });
    const out = await scrubbedTho894(mp4);
    expect(containsTho894(out, 'LIVE-PHOTO-PAIR')).toBe(false);
    expect(containsTho894(out, '18.1')).toBe(true);
  });

  it('treats a PNG Source like Author, since it names the device', async () => {
    const png = Buffer.concat([
      PNG_SIGNATURE_THO894, IHDR_THO894,
      pngChunkTho894('tEXt', Buffer.from('Source\0Source-Pixel 8 Pro', 'latin1')),
      IDAT_THO894, IEND_THO894,
    ]);
    const out = await scrubbedTho894(png);
    expect(containsTho894(out, 'Source-Pixel')).toBe(false);
    expect(await planScrub(out)).toEqual([]);
  });

  it('blanks a C2PA manifest in a JPEG, a PNG and an MP4, which can carry the place and the person', async () => {
    // A JUMBF superbox labelled c2pa, split over two APP11 segments of one box
    // instance, the way a manifest larger than a segment is written.
    const app11 = (seq, body) => {
      const payload = Buffer.concat([Buffer.from('JP', 'latin1'), Buffer.from([0, 7]), u32Tho894Review(seq), body]);
      const head = Buffer.alloc(4);
      head.writeUInt16BE(0xffeb, 0);
      head.writeUInt16BE(payload.length + 2, 2);
      return Buffer.concat([head, payload]);
    };
    const jumbHead = Buffer.concat([u32Tho894Review(200), Buffer.from('jumb', 'latin1')]);
    const first = Buffer.concat([jumbHead, u32Tho894Review(29), Buffer.from('jumd', 'latin1'),
      Buffer.from('6332706100110010800000aa00389b71', 'hex'), Buffer.from([3]), Buffer.from('c2pa\0', 'latin1'),
      Buffer.from('c2pa-part-one GPS 59.9139', 'latin1')]);
    const second = Buffer.concat([jumbHead, Buffer.from('c2pa-part-two Owner-Name', 'latin1')]);
    const jpeg = Buffer.concat([minimalJpegTho894.subarray(0, 2), app11(1, first), app11(2, second), minimalJpegTho894.subarray(2)]);

    const png = Buffer.concat([
      PNG_SIGNATURE_THO894, IHDR_THO894,
      pngChunkTho894('caBX', Buffer.concat([jumbHead, Buffer.from('c2pa-png GPS 59.9139', 'latin1')])),
      IDAT_THO894, IEND_THO894,
    ]);

    const c2paUuid = mp4BoxTho894Review('uuid', Buffer.from('d8fec3d61b0e483c92975828877ec481', 'hex'), 'c2pa-mp4 GPS 59.9139');
    const mp4 = mp4WithLocationTho894({ location: false, topLevelTho894Review: [c2paUuid] });

    for (const file of [jpeg, png, mp4]) {
      const out = await scrubbedTho894(file);
      expect(out.length).toBe(file.length);
      expect(containsTho894(out, 'GPS 59.9139')).toBe(false);
      expect(containsTho894(out, 'Owner-Name')).toBe(false);
      expect(await planScrub(out)).toEqual([]);
    }
  });

  it('leaves an APP11 that is not a C2PA manifest alone', async () => {
    // JPEG XT keeps an HDR residual in APP11 JUMBF boxes too; only c2pa goes.
    const payload = Buffer.concat([Buffer.from('JP', 'latin1'), Buffer.from([0, 1]), u32Tho894Review(1),
      u32Tho894Review(40), Buffer.from('jumb', 'latin1'), u32Tho894Review(24), Buffer.from('jumd', 'latin1'),
      Buffer.alloc(16, 0x11), Buffer.from([3]), Buffer.from('xt\0', 'latin1')]);
    const head = Buffer.alloc(4);
    head.writeUInt16BE(0xffeb, 0);
    head.writeUInt16BE(payload.length + 2, 2);
    const jpeg = Buffer.concat([minimalJpegTho894.subarray(0, 2), head, payload, minimalJpegTho894.subarray(2)]);
    expect(await planScrub(jpeg)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Round 3 of the THO-894 review: the walks that did not pay into the budget.

describe('planScrub after the THO-894 review, round 3', () => {
  it('refuses an Apple key name longer than any Apple writes, before decoding it', async () => {
    // A key entry may be the whole keys box: one 240 MiB name was a 240 MiB
    // JS string and a second of blocked loop. Apple's names are under 64 bytes.
    const box = mp4BoxTho894Review;
    const name = Buffer.alloc(2048, 0x61);
    const entry = Buffer.concat([u32Tho894Review(name.length + 8), Buffer.from('mdta', 'latin1'), name]);
    const meta = box('meta', box('hdlr', u32Tho894Review(0), u32Tho894Review(0), 'mdta', Buffer.alloc(12)),
      box('keys', u32Tho894Review(0), u32Tho894Review(1), entry), box('ilst'));
    const mp4 = Buffer.concat([box('ftyp', 'isom', u32Tho894Review(0x200), 'isommp42'), box('moov', box('mvhd', Buffer.alloc(100)), meta)]);
    await expect(planScrub(mp4)).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
  });

  it('counts EXIF directory entries against the budget, across every block', async () => {
    // Bounded per block (32 × 512) but not across blocks: 4,261 APP1 segments
    // of 5,120 entries each were 21.8M entries and 0.75 s for nothing.
    const entries = Array.from({ length: 512 }, () => ({ tag: 0x0001, type: 3, value: shortTho894Review(1) }));
    const ifds = Array.from({ length: 10 }, () => entries.map((e) => ({ ...e })));
    const next = Object.fromEntries(ifds.slice(1).map((_, i) => [i, i + 1]));
    const { tiff } = tiffFromIfdsTho894Review(ifds, { next });
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const head = Buffer.alloc(4);
    head.writeUInt16BE(0xffe1, 0);
    head.writeUInt16BE(payload.length + 2, 2);
    const segment = Buffer.concat([head, payload]);
    const many = Buffer.concat(Array.from({ length: 200 }, () => segment));
    const jpeg = Buffer.concat([minimalJpegTho894.subarray(0, 2), many, minimalJpegTho894.subarray(2)]);
    await expect(planScrub(jpeg)).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
  });
});

// Round 4 of the THO-894 review: an EXIF header a reader accepts and the
// planner did not. "Exif\0\xFF" planned nothing and went out with its GPS.
describe('planScrub on a loose EXIF header (THO-894 review, round 4)', () => {
  const withExifHeaderTho894Round4 = (header) => {
    const { jpeg } = jpegWithGpsTho894();
    const exifAt = jpeg.indexOf('Exif\0\0', 0, 'latin1');
    const out = Buffer.from(jpeg);
    Buffer.from(header, 'latin1').copy(out, exifAt);
    return out;
  };

  it('scrubs EXIF behind "Exif\\0" whatever its sixth byte, as exiftool reads it', async () => {
    const odd = withExifHeaderTho894Round4('Exif\0\xff');
    expect(containsTho894(odd, 'SN-1234567890')).toBe(true);
    const out = await scrubbedTho894(odd);
    expect(containsTho894(out, 'SN-1234567890')).toBe(false);
    expect(await planScrub(out)).toEqual([]);
  });

  it('refuses an APP1 a reader could take for EXIF that the planner does not read, rather than call it clean', async () => {
    // Shifted by one byte: exiftool still finds "Exif\0" within four bytes.
    const { jpeg } = jpegWithGpsTho894();
    const exifAt = jpeg.indexOf('Exif\0\0', 0, 'latin1');
    const shifted = Buffer.from(jpeg);
    shifted.write('XExif\0', exifAt, 'latin1');
    await expect(planScrub(shifted)).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
    // And "Exif\0" with no TIFF header after it.
    const noTiff = Buffer.from(jpeg);
    noTiff.write('Exif\0\0ZZZZ', exifAt, 'latin1');
    await expect(planScrub(noTiff)).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
  });
});
