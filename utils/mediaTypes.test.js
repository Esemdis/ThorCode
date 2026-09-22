import { describe, it, expect } from 'vitest';
import {
  MAX_FILE_BYTES, MAX_POSTER_BYTES, kindForMime, posterProblem,
} from './mediaTypes.js';

describe('kindForMime', () => {
  it('recognises the formats a Pixel produces', () => {
    expect(kindForMime('image/jpeg')).toBe('PHOTO');
    expect(kindForMime('video/mp4')).toBe('VIDEO');
  });

  it('accepts PNG and WebP, which screenshots and exports arrive as', () => {
    expect(kindForMime('image/png')).toBe('PHOTO');
    expect(kindForMime('image/webp')).toBe('PHOTO');
  });

  it('ignores parameters on the content type', () => {
    expect(kindForMime('image/jpeg; charset=binary')).toBe('PHOTO');
  });

  it('is case insensitive, because clients disagree about that', () => {
    expect(kindForMime('IMAGE/JPEG')).toBe('PHOTO');
  });

  it('rejects HEIC outright rather than storing something no browser renders', () => {
    // A Pixel does not produce these, but a file copied from elsewhere might,
    // and a stored file that silently refuses to display looks like a bug in
    // the gallery rather than a bad import.
    expect(kindForMime('image/heic')).toBeNull();
    expect(kindForMime('image/heif')).toBeNull();
  });

  it('rejects anything not on the list', () => {
    expect(kindForMime('application/pdf')).toBeNull();
    expect(kindForMime('')).toBeNull();
    expect(kindForMime(undefined)).toBeNull();
  });
});

describe('MAX_FILE_BYTES', () => {
  it('is a long clip and not a mistake', () => {
    // 4K60 off a phone runs around 400 MB a minute, so a full-set recording
    // went past the 500 MB this replaced without trying.
    expect(MAX_FILE_BYTES).toBeGreaterThan(1.9 * 1024 * 1024 * 1024);
  });

  it('fits in the Int column that stores it', () => {
    // ConcertMedia.bytes is an Int. A round 2 GiB is INT32_MAX + 1, and
    // busboy only fires `limit` when a file EXCEEDS fileSize — so a file of
    // exactly that size was accepted, uploaded in full, and then failed the
    // insert with "value out of range for type integer", which unlinks the
    // bytes and 500s after several minutes of upload.
    expect(MAX_FILE_BYTES).toBeLessThanOrEqual(2147483647);
  });
});

describe('posterProblem', () => {
  it('accepts the webp frame the upload dialog draws', () => {
    expect(posterProblem({ mimetype: 'image/webp', size: 40_000 })).toBeNull();
  });

  it('ignores parameters and case the way kindForMime does', () => {
    expect(posterProblem({ mimetype: 'IMAGE/WEBP; charset=binary', size: 10 })).toBeNull();
  });

  it('refuses anything that is not a webp', () => {
    // The posters field skips kindForMime, because a poster never becomes a
    // row and a bad one costs a placeholder rather than the upload. That left
    // it as the one field in the route where arbitrary bytes reached sharp.
    expect(posterProblem({ mimetype: 'video/mp4', size: 40_000 })).toMatch(/image\/webp/);
    expect(posterProblem({ mimetype: undefined, size: 10 })).toMatch(/image\/webp/);
  });

  it('holds a poster to its own cap, far below a video\'s', () => {
    // Posters shared MAX_FILE_BYTES, which is sized for a full-set recording.
    // A poster is one canvas frame, so fifty of them at the video limit was
    // 100 GB the route would have tried to hold at once.
    expect(posterProblem({ mimetype: 'image/webp', size: MAX_POSTER_BYTES + 1 })).toMatch(/limit/);
    expect(MAX_POSTER_BYTES).toBeLessThan(MAX_FILE_BYTES / 100);
  });
});
