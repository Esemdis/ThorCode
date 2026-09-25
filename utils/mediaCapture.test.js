import { describe, it, expect } from 'vitest';
import { capturedAtFor } from './mediaCapture.js';

describe('capturedAtFor', () => {
  it('keeps a time from the night of the gig', () => {
    expect(capturedAtFor('2026-09-03T20:40:51.000Z', 'VIDEO', new Date('2026-09-03T18:00:00Z')))
      .toBe('2026-09-03T20:40:51.000Z');
  });

  it('keeps a set that ran past midnight', () => {
    expect(capturedAtFor('2026-09-04T01:10:00.000Z', 'VIDEO', new Date('2026-09-03T18:00:00Z')))
      .toBe('2026-09-04T01:10:00.000Z');
  });

  it('drops a time from a different week rather than storing it', () => {
    // The client is the source of this value and a client can lie. A stored
    // capture time that contradicts its own show would corrupt the ordering
    // for every other clip that night, not just its own.
    expect(capturedAtFor('2026-09-20T13:57:16.000Z', 'VIDEO', new Date('2026-09-03T18:00:00Z')))
      .toBeNull();
  });

  it('drops a 1904 epoch', () => {
    expect(capturedAtFor('1904-01-01T00:00:00.000Z', 'VIDEO', new Date('2026-09-03T18:00:00Z')))
      .toBeNull();
  });

  it('stores a capture time on a photo now that one can be read', () => {
    // This used to refuse stills outright, because only a video takes a song
    // and only a song needed the ordering. The gallery needs it too — it shows
    // a night in the order it happened — and a still's time comes off its own
    // EXIF in utils/exifCapturedAt.js. The guard here is the same either way.
    expect(capturedAtFor('2026-09-03T20:40:51.000Z', 'PHOTO', new Date('2026-09-03T18:00:00Z')))
      .toBe('2026-09-03T20:40:51.000Z');
  });

  it('holds a photo to the same window as a clip', () => {
    // A stamp that contradicts its own show is not believed whatever it is on.
    expect(capturedAtFor('2019-01-01T12:00:00.000Z', 'PHOTO', new Date('2026-09-03T18:00:00Z')))
      .toBeNull();
  });

  it('still refuses a kind it does not know', () => {
    expect(capturedAtFor('2026-09-03T20:40:51.000Z', 'AUDIO', new Date('2026-09-03T18:00:00Z')))
      .toBeNull();
  });

  it('shrugs off anything that is not a timestamp', () => {
    for (const junk of [null, undefined, '', 'tomorrow', 42, {}]) {
      expect(capturedAtFor(junk, 'VIDEO', new Date('2026-09-03T18:00:00Z'))).toBeNull();
    }
  });

  it('is null when the show has no date to check against', () => {
    expect(capturedAtFor('2026-09-03T20:40:51.000Z', 'VIDEO', null)).toBeNull();
  });

  it('reads a date-only concert day without parsing it locally', () => {
    // concert_date arrives as a calendar day for some sources. Sliced, never
    // parsed — a local parse slides the day backwards west of UTC.
    expect(capturedAtFor('2026-09-03T20:40:51.000Z', 'VIDEO', '2026-09-03'))
      .toBe('2026-09-03T20:40:51.000Z');
  });
});
