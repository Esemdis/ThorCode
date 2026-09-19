import { describe, it, expect, beforeEach } from 'vitest';
import {
  slugSegment, showFolderName, showFolderRelPath, uniqueFilename,
  resolveArchivePath, thumbPath, archiveRoot,
} from './mediaPaths.js';

beforeEach(() => { process.env.MEDIA_ROOT = '/media'; });

describe('slugSegment', () => {
  it('keeps the text readable rather than reducing it to a machine slug', () => {
    // The whole point of the archive layout is that a human can read it in a
    // file browser, so spaces and case survive. This is not a URL slug.
    expect(slugSegment('Sentrum Scene')).toBe('Sentrum Scene');
  });

  it('removes the characters that would split a path or break an SMB share', () => {
    // The share is mounted over SMB on Unraid, where these are illegal even
    // though ext4 would accept most of them.
    expect(slugSegment('AC/DC: Live? <loud>')).toBe('AC-DC- Live- -loud-');
  });

  it('refuses to produce a name that is only dots', () => {
    // '.' and '..' resolve to directories that already exist, so a show named
    // out of them would write into the parent of the archive.
    expect(slugSegment('..')).toBe('-');
    expect(slugSegment('.')).toBe('-');
  });

  it('trims trailing dots and spaces, which Windows silently drops', () => {
    // A folder created as 'Gojira ' is read back as 'Gojira' over SMB, and the
    // rebuild then reports every file in it as drift.
    expect(slugSegment('Gojira . ')).toBe('Gojira');
  });

  it('caps the length so the whole path stays under the filesystem limit', () => {
    expect(slugSegment('x'.repeat(200))).toHaveLength(80);
  });
});

describe('showFolderName', () => {
  it('reads as a date, a city and who played', () => {
    expect(showFolderName({ date: '2026-06-12', city: 'Oslo', headliner: 'Gojira' }))
      .toBe('2026-06-12 Oslo - Gojira');
  });

  it('still names the folder when the headliner is unknown', () => {
    expect(showFolderName({ date: '2026-06-12', city: 'Oslo', headliner: '' }))
      .toBe('2026-06-12 Oslo');
  });
});

describe('showFolderRelPath', () => {
  it('puts every user under their own subtree', () => {
    // Band rows are global in this schema and have leaked across accounts
    // before. A shared media tree is the same bug with worse consequences.
    expect(showFolderRelPath('user-1', { date: '2026-06-12', city: 'Oslo', headliner: 'Gojira' }))
      .toBe('user-1/2026-06-12 Oslo - Gojira');
  });

  it('sanitises the user id too, since it reaches the path', () => {
    expect(showFolderRelPath('../root', { date: '2026-06-12', city: 'Oslo', headliner: 'X' }))
      .toBe('-root/2026-06-12 Oslo - X');
  });
});

describe('uniqueFilename', () => {
  it('leaves a name alone when nothing has taken it', () => {
    expect(uniqueFilename([], 'IMG_4821.jpg')).toBe('IMG_4821.jpg');
  });

  it('suffixes before the extension so the file still opens', () => {
    expect(uniqueFilename(['IMG_4821.jpg'], 'IMG_4821.jpg')).toBe('IMG_4821 (2).jpg');
  });

  it('keeps counting past the first collision', () => {
    expect(uniqueFilename(['IMG_4821.jpg', 'IMG_4821 (2).jpg'], 'IMG_4821.jpg'))
      .toBe('IMG_4821 (3).jpg');
  });

  it('compares case-insensitively, because the share is not case sensitive', () => {
    // SMB treats IMG_1.JPG and img_1.jpg as the same file, so allowing both
    // would have the second upload overwrite the first.
    expect(uniqueFilename(['IMG_4821.JPG'], 'img_4821.jpg')).toBe('img_4821 (2).jpg');
  });
});

describe('resolveArchivePath', () => {
  it('resolves a relative path under the archive root', () => {
    expect(resolveArchivePath('user-1/show/IMG.jpg')).toBe('/media/archive/user-1/show/IMG.jpg');
  });

  it('refuses a path that climbs out of the archive', () => {
    // rel_path comes from the database, but the rebuild script writes it from
    // whatever is on disk, so this is the last line rather than the only one.
    expect(() => resolveArchivePath('../../etc/passwd')).toThrow(/outside the archive/i);
    expect(() => resolveArchivePath('/etc/passwd')).toThrow(/outside the archive/i);
  });
});

describe('archiveRoot', () => {
  it('refuses to guess when MEDIA_ROOT is unset', () => {
    // Defaulting to a relative path would write the archive inside the
    // container, where it dies with the next Watchtower update.
    delete process.env.MEDIA_ROOT;
    expect(() => archiveRoot()).toThrow(/MEDIA_ROOT/);
  });
});

describe('thumbPath', () => {
  it('names a thumbnail by the checksum of what it is a thumbnail of', () => {
    // Keyed by content, so the same photo uploaded to two shows is rendered
    // once, and a cache entry can never be stale for its key.
    expect(thumbPath('abc123')).toBe('/media/cache/thumbs/abc123.webp');
  });
});
