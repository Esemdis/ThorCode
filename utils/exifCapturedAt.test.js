import { describe, it, expect } from 'vitest';
import { exifCapturedAt } from './exifCapturedAt.js';
// Shared with the upload route's tests, which need the same bytes inside a JPEG.
import { buildExif } from '../test/exifFixture.js';

describe('exifCapturedAt', () => {
  it('resolves the local stamp to UTC with the offset beside it', () => {
    // The measurement written down in videoCapturedAt.js: a Pixel wrote
    // DateTimeOriginal 21:38:28 with OffsetTimeOriginal +02:00 for a file whose
    // name reads 19:38:28, the filenames being UTC. Getting this backwards
    // would put every photograph four hours from where it belongs.
    expect(exifCapturedAt(buildExif({
      original: '2026:06:12 21:38:28', offset: '+02:00',
    }))).toEqual({ iso: '2026-06-12T19:38:28.000Z', zoned: true });
  });

  it('applies a negative offset the other way', () => {
    expect(exifCapturedAt(buildExif({
      original: '2026:06:12 19:38:28', offset: '-05:00',
    })).iso).toBe('2026-06-13T00:38:28.000Z');
  });

  it('accepts an offset written without its colon', () => {
    expect(exifCapturedAt(buildExif({
      original: '2026:06:12 21:38:28', offset: '-0530',
    })).iso).toBe('2026-06-13T03:08:28.000Z');
  });

  it('reads a big-endian block', () => {
    // Canon and Nikon write MM. Assuming II would misread every field.
    expect(exifCapturedAt(buildExif({
      original: '2026:06:12 21:38:28', offset: '+02:00', little: false,
    }))).toEqual({ iso: '2026-06-12T19:38:28.000Z', zoned: true });
  });

  it('skips the APP1 prefix when the caller left it on', () => {
    // Some callers hand over the segment intact and some strip it; every offset
    // inside is relative to the TIFF header either way.
    expect(exifCapturedAt(buildExif({
      original: '2026:06:12 21:38:28', offset: '+02:00', prefix: true,
    })).iso).toBe('2026-06-12T19:38:28.000Z');
  });

  it('says when no offset was found, rather than implying the time is exact', () => {
    // Read as UTC, so it may be out by the venue's offset. A constant shift per
    // device per night never reorders that camera's own photographs, but it can
    // misplace them against another device's — so the caller is told.
    expect(exifCapturedAt(buildExif({ original: '2026:06:12 21:38:28' })))
      .toEqual({ iso: '2026-06-12T21:38:28.000Z', zoned: false });
  });

  it('takes a literal Z as the zone it is', () => {
    expect(exifCapturedAt(buildExif({ original: '2026:06:12 21:38:28', offset: 'Z' })))
      .toEqual({ iso: '2026-06-12T21:38:28.000Z', zoned: true });
  });

  it('falls back to the digitized stamp when the original is absent', () => {
    // For a camera the two are the same instant. IFD0's DateTime is NOT used as
    // a further fallback: it means "last changed", which is the modification
    // stamp this whole approach exists to avoid.
    expect(exifCapturedAt(buildExif({ digitized: '2026:06:12 21:38:28', offset: '+02:00' })).iso)
      .toBe('2026-06-12T19:38:28.000Z');
  });

  it('prefers the original over the digitized stamp', () => {
    expect(exifCapturedAt(buildExif({
      original: '2026:06:12 21:38:28', digitized: '2020:01:01 00:00:00', offset: '+02:00',
    })).iso).toBe('2026-06-12T19:38:28.000Z');
  });

  it('refuses the zeroed placeholder real cameras actually write', () => {
    // 0000:00:00 00:00:00 parses as a date if it is not caught, and would sort
    // every such photograph to the beginning of time.
    expect(exifCapturedAt(buildExif({ original: '0000:00:00 00:00:00' }))).toBeNull();
  });

  it('refuses a stamp it cannot read', () => {
    expect(exifCapturedAt(buildExif({ original: 'not a date' }))).toBeNull();
    expect(exifCapturedAt(buildExif({ original: '' }))).toBeNull();
  });

  it('ignores an offset it cannot read rather than discarding the time', () => {
    const read = exifCapturedAt(buildExif({ original: '2026:06:12 21:38:28', offset: '+99:00' }));
    expect(read).toEqual({ iso: '2026-06-12T21:38:28.000Z', zoned: false });
  });

  it('returns nothing when there is no Exif SubIFD to look in', () => {
    expect(exifCapturedAt(buildExif({ original: '2026:06:12 21:38:28', pointer: false }))).toBeNull();
  });

  it('returns nothing when the pointer is not a pointer', () => {
    expect(exifCapturedAt(buildExif({
      original: '2026:06:12 21:38:28', pointerType: 2,
    }))).toBeNull();
  });

  it('returns nothing when the SubIFD holds no tags at all', () => {
    expect(exifCapturedAt(buildExif({}))).toBeNull();
  });

  it('refuses a buffer that is not a TIFF block', () => {
    expect(exifCapturedAt(Buffer.from('this is a jpeg, not its exif'))).toBeNull();
    // Right byte order marker, wrong magic number.
    const wrongMagic = buildExif({ original: '2026:06:12 21:38:28' });
    wrongMagic.writeUInt16LE(43, 2);
    expect(exifCapturedAt(wrongMagic)).toBeNull();
  });

  it('survives a truncated block instead of reading past the end', () => {
    // A value offset pointing beyond the buffer is what a partially copied file
    // looks like, and an unguarded read there throws inside an upload.
    const full = buildExif({ original: '2026:06:12 21:38:28', offset: '+02:00' });
    for (let cut = 0; cut < full.length; cut += 1) {
      expect(() => exifCapturedAt(full.subarray(0, cut))).not.toThrow();
    }
  });

  it('keeps the date when truncation takes only the offset with it', () => {
    // Degrading to an unzoned time beats discarding a stamp that is entirely
    // intact, and the offset is the last thing in the block.
    const full = buildExif({ original: '2026:06:12 21:38:28', offset: '+02:00' });
    expect(exifCapturedAt(full.subarray(0, full.length - 4)))
      .toEqual({ iso: '2026-06-12T21:38:28.000Z', zoned: false });
  });

  it('gives up when truncation reaches the date itself', () => {
    const full = buildExif({ original: '2026:06:12 21:38:28', offset: '+02:00' });
    expect(exifCapturedAt(full.subarray(0, 70))).toBeNull();
  });

  it('survives a corrupt entry count instead of walking off into the image', () => {
    const buf = buildExif({ original: '2026:06:12 21:38:28' });
    buf.writeUInt16LE(60000, 26);
    expect(exifCapturedAt(buf)).toBeNull();
  });

  it('answers for nothing at all without being asked twice', () => {
    expect(exifCapturedAt(null)).toBeNull();
    expect(exifCapturedAt(undefined)).toBeNull();
    expect(exifCapturedAt(Buffer.alloc(0))).toBeNull();
    expect(exifCapturedAt(Buffer.alloc(4))).toBeNull();
  });

  it('accepts a plain Uint8Array, which is what some readers hand back', () => {
    const buf = buildExif({ original: '2026:06:12 21:38:28', offset: '+02:00' });
    expect(exifCapturedAt(new Uint8Array(buf)).iso).toBe('2026-06-12T19:38:28.000Z');
  });
});
