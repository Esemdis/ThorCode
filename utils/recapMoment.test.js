import { describe, it, expect } from 'vitest';
import { recapMoment, MAX_MOMENT_MS } from './recapMoment.js';

describe('recapMoment', () => {
  it('keeps a moment inside the video as asked', () => {
    expect(recapMoment({ start_ms: 83_000, end_ms: 95_000 }, { durationMs: 214_000 }))
      .toEqual({ range: { start_ms: 83_000, end_ms: 95_000 } });
  });

  it('keeps a moment that starts on the first frame', () => {
    // 0 is a real start, not a missing one.
    expect(recapMoment({ start_ms: 0, end_ms: 8_000 }, { durationMs: 214_000 }))
      .toEqual({ range: { start_ms: 0, end_ms: 8_000 } });
  });

  it('ends a moment asked to run a hair past the video on its last frame', () => {
    // The player's clock and the stored length disagree by a frame or so, and
    // "End here" pressed on the last frame should not be an error.
    expect(recapMoment({ start_ms: 204_000, end_ms: 214_030 }, { durationMs: 214_000 }))
      .toEqual({ range: { start_ms: 204_000, end_ms: 214_000 } });
  });

  it('refuses a moment that ends before it starts', () => {
    expect(recapMoment({ start_ms: 9_000, end_ms: 9_000 })).toEqual({ error: expect.stringMatching(/after it starts/) });
    expect(recapMoment({ start_ms: 9_000, end_ms: 4_000 })).toEqual({ error: expect.stringMatching(/after it starts/) });
  });

  it('refuses a moment that starts after the video ends', () => {
    expect(recapMoment({ start_ms: 214_000, end_ms: 220_000 }, { durationMs: 214_000 }))
      .toEqual({ error: expect.stringMatching(/starts after the video ends/) });
  });

  it('refuses a moment shorter than a second, counted after it is cut to the video', () => {
    expect(recapMoment({ start_ms: 1_000, end_ms: 1_400 })).toEqual({ error: expect.stringMatching(/at least a second/) });
    // Asked for five seconds, of which only half a second is video.
    expect(recapMoment({ start_ms: 213_500, end_ms: 218_500 }, { durationMs: 214_000 }))
      .toEqual({ error: expect.stringMatching(/at least a second/) });
  });

  it('refuses a moment longer than a slide should run', () => {
    expect(recapMoment({ start_ms: 0, end_ms: 25_000 })).toEqual({ range: { start_ms: 0, end_ms: 25_000 } });
    expect(recapMoment({ start_ms: 0, end_ms: 27_000 })).toEqual({ error: 'A moment can be at most 25 seconds long' });
    expect(recapMoment({ start_ms: 0, end_ms: MAX_MOMENT_MS })).toEqual({ range: { start_ms: 0, end_ms: MAX_MOMENT_MS } });
    expect(recapMoment({ start_ms: 0, end_ms: MAX_MOMENT_MS + 1 })).toEqual({ error: expect.stringMatching(/at most/) });
  });

  it('trusts the ends when the video\'s length was never read', () => {
    // A clip uploaded before durations were probed has none, and there is
    // nothing to check against but the ends themselves.
    expect(recapMoment({ start_ms: 500_000, end_ms: 510_000 }, { durationMs: null }))
      .toEqual({ range: { start_ms: 500_000, end_ms: 510_000 } });
  });
});
