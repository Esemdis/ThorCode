/**
 * Where a photograph or a video was taken, and what took it, cut out of the
 * copy a stranger is given (THO-894).
 *
 * A share link hands out originals, and a phone original carries the GPS
 * position it was shot at — a photograph filed under a night may have been
 * taken at home before leaving. So every file a public route serves goes
 * through here first.
 *
 * Every change is a same-length patch: a value zeroed, a box renamed to `free`.
 * Nothing is re-encoded and no byte moves. That is the whole design, for three
 * reasons:
 *
 *   - "the original in full quality" stays true. Re-encoding a JPEG loses
 *     quality, and there is no ffmpeg in this image to re-mux a video (see
 *     mediaThumbs.js for why).
 *   - an MP4's sample tables point at absolute file offsets. Removing a box from
 *     `moov` would shift `mdat` and break every one of them; renaming it to
 *     `free` and zeroing it moves nothing.
 *   - the result can be checked: planning the patched copy again must find
 *     nothing, which is how mediaPublicCopy.js knows it worked.
 *
 * Fail closed throughout. Anything that does not parse, or parses to an offset
 * outside its own block, throws UNSCRUBBABLE rather than returning "nothing to
 * do" — a planner that gave up quietly would hand out exactly the file this
 * exists to stop. The route answers that with a 404.
 *
 * The format is decided by the file's own first bytes, never by its name.
 */

const { open } = require('node:fs/promises');
const { TYPE_BYTES, readHeader } = require('./exifCapturedAt');

/**
 * What this planner knows how to strip. mediaPublicCopy.js writes it into
 * every verdict it caches, so a copy made, or a file called clean, by an older
 * planner is looked at again rather than trusted. Bump it whenever the planner
 * learns to remove something it used to leave (THO-899, say), and whenever it
 * refuses more or less than it did — a budget raised or lowered, a parse bug
 * fixed, `cmov` accepted — because refusals are cached too. Without that, every
 * file a share link had already served would keep its old verdict, and every
 * refused one its 404, until someone emptied cache/public by hand.
 */
const SCRUB_VERSION = 1;

function unscrubbable(reason) {
  const err = new Error(`cannot scrub: ${reason}`);
  err.code = 'UNSCRUBBABLE';
  return err;
}

// Far above anything a real file needs — a phone JPEG plans about ten patches,
// a phone video a dozen — and low enough that a file made of millions of tiny
// boxes is a refusal rather than millions of patch objects in the heap.
const MAX_PATCHES = 10000;

// How many boxes (MP4) or chunks and segments (images) one file may have
// walked, counted as they are walked rather than after: a meta of 31 million
// empty children was 31 million objects and a heap OOM, which takes the whole
// API down and is no exception a route can answer with a 404. A phone moov has
// a few hundred boxes and a long fragmented recording tens of thousands, so
// 250,000 leaves room. An image gets more: a big PNG may be cut into tens of
// thousands of IDAT chunks, while a million costs well under a second.
const MAX_MP4_BOXES = 250000;
const MAX_IMAGE_BLOCKS = 1000000;

/**
 * The limits one file's planning shares across every block it walks.
 *
 * `bytes` is how much may be blanked in all, and it is the file's own size:
 * real metadata values never overlap, so a plan can only exceed it when many
 * entries point at the same bytes — five hundred EXIF entries at one 200 MB
 * value were five hundred 200 MB copies. Charged before anything is allocated.
 * `blocks` counts down the boxes, chunks or segments still allowed.
 */
const budgetFor = (size, blocks) => ({ bytes: size, patches: 0, blocks });

function step(ctx, count = 1) {
  ctx.budget.blocks -= count;
  if (ctx.budget.blocks < 0) throw unscrubbable('more boxes or chunks than any real file has');
}

function charge(ctx, length) {
  ctx.budget.bytes -= length;
  if (ctx.budget.bytes < 0) throw unscrubbable('more to blank than the file holds');
}

function push(ctx, at, bytes) {
  ctx.budget.patches += 1;
  if (ctx.budget.patches > MAX_PATCHES) throw unscrubbable('more patches than any real file needs');
  ctx.out.push({ offset: ctx.base + at, bytes });
}

// A patch is only planned when it changes something, so a scrubbed file plans
// to nothing — the re-check after patching depends on that.
function put(ctx, at, bytes) {
  if (at < 0 || at + bytes.length > ctx.buf.length) throw unscrubbable('patch outside the file');
  charge(ctx, bytes.length);
  if (ctx.buf.compare(bytes, 0, bytes.length, at, at + bytes.length) === 0) return;
  push(ctx, at, Buffer.from(bytes));
}

// The same for a run of one byte, checked before the run is allocated: a
// region that is already blank costs nothing but the look.
function fill(ctx, at, length, byte) {
  if (at < 0 || at + length > ctx.buf.length) throw unscrubbable('patch outside the file');
  charge(ctx, length);
  let i = at;
  while (i < at + length && ctx.buf[i] === byte) i += 1;
  if (i === at + length) return;
  push(ctx, at, Buffer.alloc(length, byte));
}

// ---------------------------------------------------------------------------
// EXIF (a TIFF block), shared by JPEG, PNG and WebP.

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;

// Blanked wherever they turn up: the camera and the person, not the picture.
// Orientation, the capture time and its offset, and the colour profile are
// kept — without them the photograph is shown on its side, out of order, or in
// the wrong colours.
const BLANK_TAGS = new Set([
  0x010f, // Make
  0x0110, // Model
  0x013b, // Artist
  0x013c, // HostComputer — Apple writes the phone's model here on edited shots
  0x02bc, // XMLPacket — XMP kept inside the EXIF block instead of its own APP1
  0x8298, // Copyright — usually the owner's name
  0x83bb, // IPTC-NAA — IPTC inside the EXIF block: city, sub-location, by-line
  0x9c9d, // XPAuthor — Windows' author field, UTF-16
  0x927c, // MakerNote — Apple and Samsung keep location and serials in here too
  0xa420, // ImageUniqueID
  0xa430, // CameraOwnerName
  0xa431, // BodySerialNumber
  0xa433, // LensMake
  0xa434, // LensModel
  0xa435, // LensSerialNumber
]);

// exifCapturedAt's table, plus type 13 (IFD): some writers type the pointers
// that way. Reading a pointer is the one thing that table never had to do.
const SCRUB_TYPE_BYTES = { ...TYPE_BYTES, 13: 4 };

// As in exifCapturedAt: a real IFD holds a few dozen entries.
const MAX_IFD_ENTRIES = 512;
const ENTRY_BYTES = 12;
// A camera writes two to four directories: IFD0, the thumbnail's IFD1, Exif
// and GPS. A PNG or WebP EXIF chunk is not capped at 64 KB as an APP1 is, and
// a chain of sixteen million empty IFDs held the event loop for eight seconds.
const MAX_IFDS = 32;

/**
 * Plan the patches for one TIFF block that runs from `start` to `end` in
 * ctx.buf. Every offset inside it is measured from `start` and must land
 * before `end`; one that does not throws, because a value that cannot be found
 * cannot be blanked.
 *
 * This is a stricter walk than exifCapturedAt's, deliberately. That reader may
 * skip an entry it cannot make sense of and still return a time; this one must
 * not skip anything that could be the location.
 */
function planTiff(ctx, start, end) {
  const { buf } = ctx;
  if (end > buf.length || end - start < 8) throw unscrubbable('EXIF too short');
  const header = readHeader(buf.subarray(0, end), start);
  if (!header) throw unscrubbable('EXIF without a TIFF header');
  const { little, ifd0 } = header;
  const r16 = (at) => (little ? buf.readUInt16LE(at) : buf.readUInt16BE(at));
  const r32 = (at) => (little ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
  const w16 = (v) => { const b = Buffer.alloc(2); if (little) b.writeUInt16LE(v); else b.writeUInt16BE(v); return b; };

  // Absolute position of `length` bytes at offset `off` in the block.
  const at = (off, length) => {
    if (off < 0 || start + off + length > end) throw unscrubbable('EXIF offset outside its block');
    return start + off;
  };

  const seen = new Set();
  function readDir(off) {
    if (seen.has(off)) throw unscrubbable('EXIF directories loop');
    seen.add(off);
    if (seen.size > MAX_IFDS) throw unscrubbable('more EXIF directories than any camera writes');
    const base = at(off, 2);
    const count = r16(base);
    if (count > MAX_IFD_ENTRIES) throw unscrubbable('EXIF directory too large');
    // Each entry is a block: bounded per TIFF block, but a JPEG of thousands
    // of APP1 segments was 21.8M entries walked for nothing.
    step(ctx, count + 1);
    at(off + 2, count * ENTRY_BYTES);
    const entries = [];
    for (let i = 0; i < count; i += 1) {
      const entry = base + 2 + i * ENTRY_BYTES;
      const tag = r16(entry);
      const type = r16(entry + 2);
      const components = r32(entry + 4);
      const width = SCRUB_TYPE_BYTES[type];
      if (!width) {
        // A type nobody defined has no measurable length, which is fine for a
        // tag we keep and not for one we have to blank.
        if (BLANK_TAGS.has(tag) || tag === TAG_GPS_IFD || tag === TAG_EXIF_IFD) {
          throw unscrubbable(`EXIF tag ${tag} of unknown type ${type}`);
        }
        entries.push({ tag, entry, unmeasured: true });
        continue;
      }
      const bytes = width * components;
      const valueAt = bytes <= 4 ? entry + 8 : at(r32(entry + 8), bytes);
      entries.push({ tag, type, entry, valueAt, bytes });
    }
    // The next-directory pointer is optional in practice: some writers end the
    // block right after the last entry.
    const nextAt = start + off + 2 + count * ENTRY_BYTES;
    const next = nextAt + 4 <= end ? r32(nextAt) : 0;
    return { base, count, entries, next };
  }

  const pointer = (e) => (e.type === 3 ? r16(e.valueAt) : r32(e.valueAt));

  function blankIn(dir) {
    for (const e of dir.entries) {
      if (BLANK_TAGS.has(e.tag)) fill(ctx, e.valueAt, e.bytes, 0);
    }
  }

  // GPS goes entirely: every value it points at zeroed — the coordinates are
  // RATIONALs, stored out of line, and an entry zeroed in front of them would
  // leave them sitting in the block for anyone who looks — then the entries,
  // then the count, so a reader finds an empty directory.
  function emptyGps(off) {
    const dir = readDir(off);
    for (const e of dir.entries) {
      if (e.unmeasured) throw unscrubbable('GPS entry of unknown type');
      if (e.bytes > 4) fill(ctx, e.valueAt, e.bytes, 0);
    }
    fill(ctx, dir.base + 2, dir.count * ENTRY_BYTES, 0);
    put(ctx, dir.base, w16(0));
  }

  // The Exif and GPS pointers are followed from every directory, not only
  // IFD0 where the standard puts them: a GPS directory reached from IFD1 is
  // just as readable to anyone who looks. Two pointers to one GPS directory
  // empty it once; a GPS pointer at a directory already read as something
  // else is a loop, and refused like one.
  const emptied = new Set();
  function visit(dir) {
    blankIn(dir);
    for (const e of dir.entries) {
      if (e.unmeasured) continue;
      if (e.tag === TAG_EXIF_IFD) {
        const subOff = pointer(e);
        if (subOff !== 0 && !seen.has(subOff)) visit(readDir(subOff));
      } else if (e.tag === TAG_GPS_IFD) {
        const gpsOff = pointer(e);
        if (gpsOff !== 0 && !emptied.has(gpsOff)) {
          emptied.add(gpsOff);
          emptyGps(gpsOff);
        }
      }
    }
  }

  let off = ifd0;
  while (off !== 0) {
    const dir = readDir(off);
    visit(dir);
    off = dir.next;
  }
}

// EXIF inside a container sometimes keeps the JPEG's `Exif\0\0` prefix (WebP
// writers disagree) and sometimes not.
function exifPrefixed(buf, at, end) {
  return end - at >= 6 && buf.toString('latin1', at, at + 6) === 'Exif\0\0' ? at + 6 : at;
}

// ---------------------------------------------------------------------------
// JPEG

const XMP_NAMESPACES = ['http://ns.adobe.com/xap/1.0/\0', 'http://ns.adobe.com/xmp/extension/\0'];

function startsWith(buf, at, end, text) {
  return end - at >= text.length && buf.toString('latin1', at, at + text.length) === text;
}

// A C2PA manifest store, as the JUMBF description box's type: the manifest
// can carry the capture's EXIF (GPS included) and the creator's identity, and
// the scrub has already broken its signature by patching the file it signs.
const C2PA_JUMBF_TYPE = Buffer.from('6332706100110010800000aa00389b71', 'hex');

/**
 * APP11 holds JUMBF boxes, one box instance split over as many segments as it
 * needs, each opening `JP`, the instance number and a sequence number. Only a
 * C2PA manifest is blanked, every segment of its instance: JPEG XT keeps an
 * HDR residual in APP11 too, and that is the picture, not metadata.
 */
function planApp11(ctx, payload, end, c2paInstances) {
  const { buf } = ctx;
  if (!startsWith(buf, payload, end, 'JP') || end - payload < 8) return;
  const instance = buf.readUInt16BE(payload + 2);
  const sequence = buf.readUInt32BE(payload + 4);
  if (sequence === 1) {
    const box = payload + 8;
    const isC2pa = end - box >= 41
      && buf.toString('latin1', box + 4, box + 8) === 'jumb'
      && buf.toString('latin1', box + 12, box + 16) === 'jumd'
      && (buf.compare(C2PA_JUMBF_TYPE, 0, 16, box + 16, box + 32) === 0
        || startsWith(buf, box + 33, end, 'c2pa'));
    if (isC2pa) c2paInstances.add(instance);
  }
  if (c2paInstances.has(instance)) fill(ctx, payload, end - payload, 0);
}

// Readers are looser about the EXIF header than "Exif\0\0": exiftool takes up
// to four bytes before "Exif\0" and any byte after it. Recognising only the
// exact header, an APP1 of "Exif\0\xFF" planned nothing, was called clean
// and went out with its GPS and serial (THO-894 review). So "Exif\0" at the
// start is planned whatever its sixth byte (planTiff refuses it without a
// TIFF header), and anything else that a reader could take for EXIF is
// refused rather than passed through. In any case: exiftool matches the
// header case-insensitively, and "EXIF\0\0" planned nothing and went out
// with its GPS (round 2 of the review). Only the exact "Exif\0" is planned;
// every other spelling is refused.
const LOOKS_LIKE_EXIF = /^[\s\S]{0,4}exif/i;

function planApp1(ctx, payload, end) {
  const { buf } = ctx;
  if (startsWith(buf, payload, end, 'Exif\0')) {
    planTiff(ctx, payload + 6, end);
  } else if (LOOKS_LIKE_EXIF.test(buf.toString('latin1', payload, Math.min(end, payload + 8)))) {
    throw unscrubbable('EXIF behind a header this planner does not read');
  } else if (XMP_NAMESPACES.some((ns) => startsWith(buf, payload, end, ns))) {
    // The namespace goes too, so what is left is an APP1 nobody claims, which
    // every reader skips; an XMP header in front of spaces is a broken packet.
    fill(ctx, payload, end - payload, 0x20);
  }
}

// Past a scan's entropy-coded data to the next marker. Inside it a 0xFF is
// either stuffed (FF 00), a restart marker (FF D0–D7) or fill before the next
// real marker.
// indexOf rather than a byte loop: the scan is nearly all of a photograph,
// and native search is many times faster over tens of megabytes.
function skipEntropy(buf, pos) {
  let i = buf.indexOf(0xff, pos);
  while (i >= 0 && i < buf.length - 1) {
    const next = buf[i + 1];
    if (!(next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff)) return i;
    i = buf.indexOf(0xff, i + 1);
  }
  throw unscrubbable('JPEG ends inside a scan');
}

// One JPEG from its SOI to just past its EOI.
function planOneJpeg(ctx, start) {
  const { buf } = ctx;
  const c2paInstances = new Set();
  let pos = start + 2;
  for (;;) {
    step(ctx);
    if (pos + 2 > buf.length || buf[pos] !== 0xff) throw unscrubbable('JPEG marker expected');
    while (pos + 2 < buf.length && buf[pos + 1] === 0xff) pos += 1;
    const marker = buf[pos + 1];
    pos += 2;
    if (marker === 0xd9) return pos;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0x00 || marker === 0xd8) throw unscrubbable('JPEG marker out of place');
    if (pos + 2 > buf.length) throw unscrubbable('JPEG segment truncated');
    const segEnd = pos + buf.readUInt16BE(pos);
    if (segEnd < pos + 2 || segEnd > buf.length) throw unscrubbable('JPEG segment overruns the file');
    if (marker === 0xe1) planApp1(ctx, pos + 2, segEnd);
    else if (marker === 0xeb) planApp11(ctx, pos + 2, segEnd, c2paInstances);
    pos = segEnd;
    if (marker === 0xda) pos = skipEntropy(buf, pos);
  }
}

// A second image after the first one's EOI: the MPF secondaries and the HDR
// gain map a current phone appends. Each carries its own APP1, and an Apple
// gain map's has been seen with the same EXIF as the primary.
const NEXT_JPEG = Buffer.from([0xff, 0xd8, 0xff]);
// A phone appends one to three (MPF secondaries, a gain map). A file of
// millions of four-byte JPEGs would otherwise be millions of walks.
const MAX_JPEG_IMAGES = 64;

function planJpeg(ctx) {
  let pos = 0;
  for (let images = 1; ; images += 1) {
    if (images > MAX_JPEG_IMAGES) throw unscrubbable('more images in one JPEG than any phone writes');
    pos = planOneJpeg(ctx, pos);
    const next = ctx.buf.indexOf(NEXT_JPEG, pos);
    if (next < 0) return;
    pos = next;
  }
}

// ---------------------------------------------------------------------------
// PNG

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Text chunks that are metadata blocks in disguise — XMP, and the "raw
// profile" chunks ImageMagick and exiftool write EXIF, XMP and IPTC into as
// hex — and the standard keywords that name a person or the device, as EXIF's
// Artist, Copyright and Model do (`Source` is "the device used to create the
// image").
const PNG_METADATA_KEYWORD = /^(XML:com\.adobe\.xmp|Raw profile type (exif|xmp|app1|iptc|8bim)|Author|Copyright|Source)$/i;
// Whole chunks that go: `caBX` is a C2PA manifest (see C2PA_JUMBF_TYPE).
const PNG_NEUTRALISE = new Set(['caBX']);
const PNG_TEXT_CHUNKS = new Set(['tEXt', 'iTXt', 'zTXt']);

// A private, ancillary, safe-to-copy chunk type that no reader interprets: the
// PNG equivalent of renaming an MP4 box to `free`.
const PNG_NEUTRAL = Buffer.from('scRb', 'latin1');

function planPng(ctx) {
  const { buf } = ctx;
  let pos = 8;
  for (;;) {
    step(ctx);
    if (pos + 12 > buf.length) throw unscrubbable('PNG ends without IEND');
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = pos + 8;
    const dataEnd = data + length;
    if (length > 0x7fffffff || dataEnd + 4 > buf.length) throw unscrubbable('PNG chunk overruns the file');

    // Its own list, so a changed chunk's CRC can be recomputed from just its
    // patches; the limits are the file's.
    const chunk = { buf, base: ctx.base, out: [], budget: ctx.budget };
    if (type === 'eXIf') {
      planTiff(chunk, exifPrefixed(buf, data, dataEnd), dataEnd);
    } else if (PNG_NEUTRALISE.has(type)) {
      put(chunk, pos + 4, PNG_NEUTRAL);
      fill(chunk, data, length, 0);
    } else if (PNG_TEXT_CHUNKS.has(type)) {
      const nul = buf.indexOf(0, data);
      const keyword = nul >= 0 && nul < dataEnd ? buf.toString('latin1', data, nul) : '';
      if (PNG_METADATA_KEYWORD.test(keyword)) {
        put(chunk, pos + 4, PNG_NEUTRAL);
        fill(chunk, data, length, 0);
      }
    }
    // A changed chunk needs its CRC recomputed over type and data, or a strict
    // decoder refuses the whole image.
    if (chunk.out.length) {
      const patched = Buffer.from(buf.subarray(pos + 4, dataEnd));
      for (const p of chunk.out) p.bytes.copy(patched, p.offset - ctx.base - (pos + 4));
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(patched));
      put(chunk, dataEnd, crc);
      ctx.out.push(...chunk.out);
    }
    if (type === 'IEND') return;
    pos = dataEnd + 4;
  }
}

// ---------------------------------------------------------------------------
// WebP

function planWebp(ctx) {
  const { buf } = ctx;
  const riffEnd = 8 + buf.readUInt32LE(4);
  if (riffEnd > buf.length) throw unscrubbable('WebP RIFF overruns the file');
  let pos = 12;
  while (pos < riffEnd) {
    step(ctx);
    if (pos + 8 > riffEnd) throw unscrubbable('WebP chunk header truncated');
    const fourcc = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const data = pos + 8;
    const end = data + size;
    if (end > riffEnd) throw unscrubbable('WebP chunk overruns the file');
    if (fourcc === 'EXIF') planTiff(ctx, exifPrefixed(buf, data, end), end);
    else if (fourcc === 'XMP ') fill(ctx, data, size, 0x20);
    // Chunks are padded to an even length, and the pad is not in the size.
    pos = end + (size & 1);
  }
}

// ---------------------------------------------------------------------------
// MP4 / QuickTime

// Renamed to `free` and zeroed wherever they are found below moov, moof or a
// file-level meta: the location (QuickTime's ©xyz, 3GPP's loci), the camera
// (©mak, ©mod), the person (QuickTime's ©aut and ©ART, 3GPP's auth; the
// copyright, ©cpy and cprt, which is usually the owner's name, as EXIF's is)
// and the QuickTime XMP box.
const MP4_NEUTRALISE = new Set([
  '\xa9xyz', 'loci', '\xa9mak', '\xa9mod', '\xa9aut', '\xa9ART', 'auth', '\xa9cpy', 'cprt', 'XMP_',
]);
// The boxes that can hold one of those somewhere below them. A fragmented
// MP4's moof and traf may carry their own udta and meta.
const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'udta', 'moof', 'traf']);
// Inside an ISO meta: an XML box can be the XMP packet itself.
const META_NEUTRALISE = new Set(['xml ', 'bxml']);
// Item boxes: the meta lists items whose bytes live somewhere else, usually in
// mdat, which is never read. An Exif item there would go out untouched.
const META_ITEMS = new Set(['iloc', 'iinf', 'idat']);
// MP4 nests about eight levels at most. A file of a hundred thousand nested
// udta boxes overflowed the stack: a 500, not the 404 every refusal is.
const MAX_BOX_DEPTH = 32;
// Adobe's XMP box and the C2PA manifest box, as a uuid box's user type.
const XMP_UUID = Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex');
const C2PA_UUID = Buffer.from('d8fec3d61b0e483c92975828877ec481', 'hex');
const METADATA_UUIDS = [XMP_UUID, C2PA_UUID];
const FREE = Buffer.from('free', 'latin1');

// mdta keys that say where, with what or whose: Apple's ISO 6709 position and
// its accuracy, the body and the phone's model, and the author, artist and
// copyright. Matched loosely rather than by Apple's names alone, because
// ffmpeg with `use_metadata_tags` writes the same position under plain keys
// (`location`, `location-eng`) — measured on a file re-muxed that way, which
// kept its coordinates under an exact match. The make/model match is
// unanchored on purpose: an iPhone also writes `camera.lens_model` ("iPhone 15
// Pro back triple camera …"), and a match on `.model` let that through
// (THO-900). Android names its maker `manufacturer`, which `make$` misses.
// `content.identifier` is the Live Photo pairing UUID, the video's
// ImageUniqueID; `camera.identifier` ("Back") goes with it, harmlessly.
const isSensitiveAppleKey = (name) => /location/i.test(name)
  || /(make|model|manufacturer)$/i.test(name)
  || /(author|artist|copyright)$/i.test(name)
  || /identifier$/i.test(name);

// Big enough for a long recording's sample tables, small enough that a
// corrupt size is a refusal rather than an attempt to read gigabytes into
// memory.
const MAX_MOOV_BYTES = 256 * 1024 * 1024;

const printableType = (buf, at) => {
  for (let i = at; i < at + 4; i += 1) {
    if (!((buf[i] >= 0x20 && buf[i] <= 0x7e) || buf[i] === 0xa9)) return false;
  }
  return true;
};

// Whether a plausible box header starts at `at`. Used only to tell Apple's
// plain `meta` from the ISO FullBox one, which has four bytes of version and
// flags before its first child.
function looksLikeBox(buf, at, end) {
  if (at + 8 > end) return false;
  const size = buf.readUInt32BE(at);
  return size >= 8 && at + size <= end && printableType(buf, at + 4);
}

function walkBoxes(ctx, start, end, visit) {
  const { buf } = ctx;
  let pos = start;
  while (pos < end) {
    const left = end - pos;
    // QuickTime allows a 32-bit zero to end a udta list.
    if (left === 4 && buf.readUInt32BE(pos) === 0) return;
    if (left < 8) throw unscrubbable('MP4 box header truncated');
    let size = buf.readUInt32BE(pos);
    let headerLen = 8;
    if (size === 1) {
      if (left < 16) throw unscrubbable('MP4 box header truncated');
      size = Number(buf.readBigUInt64BE(pos + 8));
      headerLen = 16;
    }
    if (size < headerLen || size > left) throw unscrubbable('MP4 box overruns its parent');
    step(ctx);
    visit({
      at: pos, type: buf.toString('latin1', pos + 4, pos + 8), headerLen, end: pos + size,
    });
    pos += size;
  }
}

function neutralise(ctx, box) {
  put(ctx, box.at + 4, FREE);
  fill(ctx, box.at + box.headerLen, box.end - box.at - box.headerLen, 0);
}

const isMetadataUuidAt = (buf, at, end) => end - at >= 16
  && METADATA_UUIDS.some((uuid) => buf.compare(uuid, 0, 16, at, at + 16) === 0);
const isMetadataUuid = (buf, box) => isMetadataUuidAt(buf, box.at + box.headerLen, box.end);

// Apple's key names are under 64 bytes. One entry may be the whole keys box,
// and a 240 MiB name was a 240 MiB string and a second of blocked loop.
const MAX_APPLE_KEY_BYTES = 1024;

function readAppleKeys(ctx, box) {
  const { buf } = ctx;
  const start = box.at + box.headerLen;
  if (start + 8 > box.end) throw unscrubbable('MP4 keys box truncated');
  const count = buf.readUInt32BE(start + 4);
  const names = [];
  let pos = start + 8;
  for (let i = 0; i < count; i += 1) {
    step(ctx);
    if (pos + 8 > box.end) throw unscrubbable('MP4 keys entry truncated');
    const size = buf.readUInt32BE(pos);
    if (size < 8 || pos + size > box.end) throw unscrubbable('MP4 keys entry overruns its box');
    if (size - 8 > MAX_APPLE_KEY_BYTES) throw unscrubbable('MP4 key name longer than any writer uses');
    names.push(buf.toString('utf8', pos + 8, pos + size));
    pos += size;
  }
  return names;
}

function planMeta(ctx, box, depth) {
  const { buf } = ctx;
  let start = box.at + box.headerLen;
  if (start === box.end) return;
  if (!looksLikeBox(buf, start, box.end)) {
    if (start + 4 === box.end) return;
    if (!looksLikeBox(buf, start + 4, box.end)) throw unscrubbable('MP4 meta box unreadable');
    start += 4;
  }

  const children = [];
  walkBoxes(ctx, start, box.end, (child) => children.push(child));
  if (children.some((c) => META_ITEMS.has(c.type))) throw unscrubbable('MP4 meta with items stored elsewhere');
  const hdlr = children.find((c) => c.type === 'hdlr');
  const handler = hdlr && hdlr.end - hdlr.at >= hdlr.headerLen + 12
    ? buf.toString('latin1', hdlr.at + hdlr.headerLen + 8, hdlr.at + hdlr.headerLen + 12)
    : null;

  if (handler === 'mdta') {
    // Apple's: each ilst item's box type is a 1-based index into `keys`, and
    // only the key's name says what the item holds.
    const keysBox = children.find((c) => c.type === 'keys');
    const names = keysBox ? readAppleKeys(ctx, keysBox) : [];
    for (const child of children) {
      if (child.type === 'ilst') {
        walkBoxes(ctx, child.at + child.headerLen, child.end, (item) => {
          if (item.type === 'free') return;
          const index = buf.readUInt32BE(item.at + 4);
          const name = names[index - 1];
          if (name === undefined) throw unscrubbable('MP4 ilst item without a key');
          if (isSensitiveAppleKey(name)) neutralise(ctx, item);
        });
      } else if (META_NEUTRALISE.has(child.type)) {
        neutralise(ctx, child);
      } else if (child.type !== 'keys') {
        planMoovChildren(ctx, child.at, child.end, child, depth + 1);
      }
    }
    return;
  }
  for (const child of children) {
    // An iTunes-style list's items are named boxes, so a ©mak in one is found
    // by its name like anywhere else.
    if (child.type === 'ilst') planMoovChildren(ctx, child.at + child.headerLen, child.end, null, depth + 1);
    else if (META_NEUTRALISE.has(child.type)) neutralise(ctx, child);
    else planMoovChildren(ctx, child.at, child.end, child, depth + 1);
  }
}

// One box, or the run of boxes from start to end, below moov.
function planMoovChildren(ctx, start, end, single = null, depth = 0) {
  if (depth > MAX_BOX_DEPTH) throw unscrubbable('MP4 boxes nested deeper than any file nests them');
  const visit = (box) => {
    if (box.type === 'cmov') throw unscrubbable('compressed MP4 header');
    if (MP4_NEUTRALISE.has(box.type)) return neutralise(ctx, box);
    if (box.type === 'uuid') return isMetadataUuid(ctx.buf, box) ? neutralise(ctx, box) : undefined;
    if (box.type === 'meta') return planMeta(ctx, box, depth + 1);
    if (MP4_CONTAINERS.has(box.type)) planMoovChildren(ctx, box.at + box.headerLen, box.end, null, depth + 1);
    return undefined;
  };
  if (single) visit(single);
  else walkBoxes(ctx, start, end, visit);
}

// Top-level boxes read in whole and searched like moov: the movie header, a
// file-level ISO meta, a fragmented file's moof (which can carry its own udta
// and meta), and a stray top-level udta.
const MP4_READ_WHOLE = new Set(['moov', 'meta', 'moof', 'udta']);

// Top-level headers are read through a window this big, not one read per box:
// a file of a million 8-byte boxes was a million reads and 36 s off disk.
const TOP_LEVEL_WINDOW = 64 * 1024;

/**
 * The top level is walked off the file, not out of memory: `mdat` is most of
 * a video and the only part that is never needed. The boxes above, and a
 * top-level XMP or C2PA uuid box, are read in whole.
 */
async function planMp4(source) {
  const out = [];
  const budget = budgetFor(source.size, MAX_MP4_BOXES);
  const top = { budget };
  let window = Buffer.alloc(0);
  let windowAt = 0;
  // `length` bytes at `at`: out of the window when they are in it, through a
  // fresh window when they fit in one, and read on their own (a moov) when not.
  const readAt = async (at, length) => {
    if (at >= windowAt && at + length <= windowAt + window.length) {
      return window.subarray(at - windowAt, at - windowAt + length);
    }
    if (length > TOP_LEVEL_WINDOW) return source.read(at, length);
    window = await source.read(at, Math.min(TOP_LEVEL_WINDOW, source.size - at));
    windowAt = at;
    return window.subarray(0, length);
  };
  let pos = 0;
  let sawMoov = false;
  while (pos < source.size) {
    step(top);
    const left = source.size - pos;
    if (left < 8) throw unscrubbable('MP4 ends inside a box header');
    const head = await readAt(pos, Math.min(left, 32));
    let size = head.readUInt32BE(0);
    let headerLen = 8;
    if (size === 1) {
      if (head.length < 16) throw unscrubbable('MP4 box header truncated');
      size = Number(head.readBigUInt64BE(8));
      headerLen = 16;
    } else if (size === 0) {
      size = left;
    }
    if (size < headerLen || size > left) throw unscrubbable('MP4 box overruns the file');
    const type = head.toString('latin1', 4, 8);

    const readWhole = MP4_READ_WHOLE.has(type)
      || (type === 'uuid' && isMetadataUuidAt(head, headerLen, head.length));
    if (readWhole) {
      if (size > MAX_MOOV_BYTES) throw unscrubbable(`MP4 ${type} too large`);
      const buf = await readAt(pos, size);
      const ctx = {
        buf, base: pos, out, budget,
      };
      const box = { at: 0, type, headerLen, end: size };
      if (type === 'moov') sawMoov = true;
      if (type === 'uuid') neutralise(ctx, box);
      else if (type === 'meta') planMeta(ctx, box, 0);
      else planMoovChildren(ctx, headerLen, size);
    }
    pos += size;
  }
  // A file with no movie header is not one this understands — a HEIC, say,
  // which shares the ftyp start — and "nothing found" would be a guess.
  if (!sawMoov) throw unscrubbable('MP4 without a moov box');
  return out;
}

// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// The first box of an MP4 is ftyp. Older QuickTime files open with one of the
// others, and an iPhone's .mov uploaded as video/mp4 is one of those.
const MP4_FIRST_BOXES = new Set(['ftyp', 'wide', 'free', 'skip', 'moov', 'mdat']);

function formatOf(head) {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= 8 && head.compare(PNG_SIGNATURE, 0, 8, 0, 8) === 0) return 'png';
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF'
    && head.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (head.length >= 8 && MP4_FIRST_BOXES.has(head.toString('latin1', 4, 8))) return 'mp4';
  return null;
}

// Photographs are parsed in memory. The cap is far above any phone's output
// and turns a corrupt or hostile file into a refusal rather than an attempt
// to hold gigabytes.
const MAX_IMAGE_BYTES = 256 * 1024 * 1024;

const IMAGE_PLANNERS = { jpeg: planJpeg, png: planPng, webp: planWebp };

/**
 * The patches for a file behind `source` ({size, read(offset, length)}).
 * Exported so a test can count the reads; planScrub and planScrubFile are the
 * entry points.
 */
async function planSource(source) {
  const head = await source.read(0, Math.min(source.size, 16));
  const format = formatOf(head);
  if (!format) throw unscrubbable('unrecognised format');
  if (format === 'mp4') return planMp4(source);
  if (source.size > MAX_IMAGE_BYTES) throw unscrubbable('image too large');
  const ctx = {
    buf: await source.read(0, source.size), base: 0, out: [], budget: budgetFor(source.size, MAX_IMAGE_BLOCKS),
  };
  IMAGE_PLANNERS[format](ctx);
  return ctx.out;
}

/**
 * The patches that scrub a whole file held in memory.
 *
 * @param {Buffer} buf
 * @returns {Promise<Array<{offset: number, bytes: Buffer}>>} same-length
 *   patches, empty when there is nothing to strip
 * @throws {Error} code UNSCRUBBABLE for anything it cannot parse or recognise
 */
async function planScrub(buf) {
  return planSource({
    size: buf.length,
    read: async (offset, length) => buf.subarray(offset, offset + length),
  });
}

/** The same, read off disk; a video's mdat is never read. */
async function planScrubFile(absPath) {
  const fh = await open(absPath, 'r');
  try {
    const { size } = await fh.stat();
    return await planSource({
      size,
      read: async (offset, length) => {
        const buf = Buffer.alloc(length);
        let got = 0;
        while (got < length) {
          const { bytesRead } = await fh.read(buf, got, length - got, offset + got);
          if (bytesRead === 0) throw unscrubbable('file shorter than it said');
          got += bytesRead;
        }
        return buf;
      },
    });
  } finally {
    await fh.close();
  }
}

/** Patches applied to a copy of `buf`, for tests and for checking a plan. */
function applyPatches(buf, patches) {
  const out = Buffer.from(buf);
  for (const p of patches) p.bytes.copy(out, p.offset);
  return out;
}

module.exports = {
  planScrub, planScrubFile, planSource, applyPatches, crc32, XMP_UUID, SCRUB_VERSION,
};
