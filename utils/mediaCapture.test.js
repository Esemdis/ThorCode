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

  it('never stores a capture time on a photo', () => {
    // Only a video takes a song, so only a video needs the ordering. Reading
    // EXIF off stills is a separate phase and this must not half-start it.
    expect(capturedAtFor('2026-09-03T20:40:51.000Z', 'PHOTO', new Date('2026-09-03T18:00:00Z')))
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
