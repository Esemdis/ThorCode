import { describe, it, expect, beforeEach } from 'vitest';
import {
  slugSegment, showFolderName, showFolderRelPath, uniqueFilename,
  resolveArchivePath, thumbPath, archiveRoot, posterPath, safeExtension, printableName,
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

  it('drops control characters from C0, DEL and C1 instead of passing them to the filesystem', () => {
    // THO-1004: a U+0001 in an uploaded filename survived the slug and made the
    // rename throw, failing the whole upload batch partway.
    const slugControlCharName = 'Live\u0001 Set\u007f\u0085\u009f \u0000One';
    expect(slugSegment(slugControlCharName)).toBe('Live Set One');
    expect(slugSegment('\u0001\u0002')).toBe('-');
    expect(slugSegment('a\tb')).toBe('a b');
  });

  it('does not let dropping a control character put a leading dot back', () => {
    // THO-1004 review: control characters were removed after the leading-dot
    // strip, so '\u0001.IMG_1.jpg' became '.IMG_1.jpg', a hidden file that the
    // media rebuild skips and reports missing on every run.
    expect(slugSegment('\u0001.hidden')).toBe('hidden');
    expect(slugSegment('\u0001.hidden').startsWith('.')).toBe(false);
    expect(slugSegment('\t.hidden')).toBe('hidden');
    expect(slugSegment('\u0001 .\u0002.x')).toBe('x');
  });

  it('leaves no double space where a control character sat between two spaces', () => {
    expect(slugSegment('a \u0001 b')).toBe('a b');
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

describe('posterPath', () => {
  it('puts a video poster in a dotted folder beside the video', () => {
    // Dotted so a file browser hides it and the show folder still reads as the
    // night's photographs. In the archive rather than the cache because nothing
    // on the server can decode video to remake it.
    expect(posterPath('user-1/2026-06-12 Oslo - Gojira/VID_1.mp4'))
      .toBe('/media/archive/user-1/2026-06-12 Oslo - Gojira/.posters/VID_1.mp4.webp');
  });

  it('refuses a poster path that climbs out of the archive', () => {
    expect(() => posterPath('../../etc/passwd')).toThrow(/outside the archive/i);
  });
});

describe('safeExtension', () => {
  it('keeps an ordinary extension as sent', () => {
    expect(safeExtension('IMG_1.JPG')).toBe('.JPG');
    expect(safeExtension('clip.mp4')).toBe('.mp4');
  });

  it('cleans what SMB would refuse or silently rename', () => {
    // A ":" failed the write as a 500; a trailing space was dropped by SMB,
    // leaving the file on disk under a name the index did not have.
    expect(safeExtension('x.jp:g')).toBe('.jpg');
    expect(safeExtension('photo.jpg ')).toBe('.jpg');
    expect(safeExtension('a.b?c')).toBe('.bc');
  });

  it('gives no extension rather than a broken one', () => {
    expect(safeExtension('noext')).toBe('');
    expect(safeExtension('clip.mp4.')).toBe('');
    expect(safeExtension('.jpg')).toBe('');
    expect(safeExtension('a.:?')).toBe('');
  });
});

// THO-1014: invisible format characters survived the slug, so two names that look the same were
// two folders, and a bidi override made a name read backwards in a file browser.
describe('invisible characters in a name (THO-1014)', () => {
  it('drops zero-width space, the bidi marks and overrides, word joiner and the byte-order mark', () => {
    expect(slugSegment('Gojira\u200b')).toBe('Gojira');
    expect(slugSegment('Go\u200bjira')).toBe(slugSegment('Gojira'));
    expect(slugSegment('\ufeffGojira')).toBe('Gojira');
    expect(slugSegment('a\u202Eb\u202Ac\u2066d\u2069e\u200Ef\u200Fg\u2060h')).toBe('abcdefgh');
    // The Arabic letter mark and the deprecated format characters, which the first version missed.
    expect(slugSegment('a\u061Cb\u206Ac\u206Fd')).toBe('abcd');
  });

  it('does not let dropping one put a leading dot or a double space back', () => {
    // Same reason as the control characters above: it has to run before the dot and space passes.
    expect(slugSegment('\u200b.hidden')).toBe('hidden');
    expect(slugSegment('a \u200b b')).toBe('a b');
    expect(slugSegment('\u202e\u200b')).toBe('-');
  });

  it('keeps the zero-width joiner and non-joiner, which Persian, Indic scripts and emoji are spelled with', () => {
    expect(slugSegment('می‌خواهم')).toBe('می‌خواهم');
    expect(slugSegment('👨‍👩‍👧 Live')).toBe('👨‍👩‍👧 Live');
  });

  it('drops them from an extension too, so a file is not saved as .jp<ZWSP>g', () => {
    expect(safeExtension('photo.jp\u200bg')).toBe('.jpg');
    expect(safeExtension('photo.\u202ejpg')).toBe('.jpg');
  });
});

describe('printableName (THO-1014)', () => {
  it('turns control and invisible characters into a question mark, so a name cannot forge a log line or read backwards', () => {
    expect(printableName('a\nERROR forged\u0000b\u202Ec')).toBe('a?ERROR forged?b?c');
    expect(printableName('a\u2028b\u2029c')).toBe('a?b?c');
    // Every invisible one, in a row: a global regex would skip alternate matches here.
    expect(printableName('\u200b\u200b\u200b\u200b')).toBe('????');
  });

  it('cuts to 120 characters without splitting an emoji, and survives a missing name', () => {
    const cut = printableName(`${'x'.repeat(119)}😀tail`);
    expect(Array.from(cut)).toHaveLength(120);
    expect(cut.endsWith('😀')).toBe(true);
    expect(printableName(undefined)).toBe('');
    expect(printableName('Live Set — Köln.jpg')).toBe('Live Set — Köln.jpg');
  });
});
