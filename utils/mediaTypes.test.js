import { describe, it, expect } from 'vitest';
import { MAX_FILE_BYTES, kindForMime } from './mediaTypes.js';

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
  it('is 2 GB, which is a long clip and not a mistake', () => {
    // 4K60 off a phone runs around 400 MB a minute, so a full-set recording
    // went past the 500 MB this replaced without trying.
    expect(MAX_FILE_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });
});
