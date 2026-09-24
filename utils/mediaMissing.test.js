import { describe, it, expect } from 'vitest';
import { showDir, groupMissing, showLabel } from './mediaMissing.js';

const row = (over = {}) => ({
  id: 1,
  rel_path: 'user-1/2026-06-12 Oslo - Bilmuri/IMG_1.jpg',
  filename: 'IMG_1.jpg',
  kind: 'PHOTO',
  bytes: 2 * 1024 * 1024,
  fileExists: true,
  folderExists: true,
  attendance_rel: {
    wishlist_rel: { user_id: 'user-1' },
    concert_rel: { concert_date: '2026-06-12T00:00:00.000Z', venue: 'Sentrum Scene', city: 'Oslo' },
  },
  ...over,
});

describe('showDir', () => {
  it('names the show folder a file sits in', () => {
    expect(showDir('user-1/2026-06-12 Oslo - Bilmuri/IMG_1.jpg'))
      .toBe('user-1/2026-06-12 Oslo - Bilmuri');
  });

  it('returns an empty string for a file with no folder rather than a dot', () => {
    // '.' would be grouped and printed as though it were a real directory.
    expect(showDir('IMG_1.jpg')).toBe('');
  });

  it('survives a missing rel_path instead of throwing mid-audit', () => {
    expect(showDir(undefined)).toBe('');
    expect(showDir(null)).toBe('');
  });
});

describe('groupMissing', () => {
  it('says nothing is missing when every file is present', () => {
    const report = groupMissing([row(), row({ id: 2 })]);
    expect(report).toMatchObject({ present: 2, missing: 0, bytes: 0, shows: [] });
  });

  it('counts the bytes that would have to be moved', () => {
    const report = groupMissing([
      row({ id: 1, fileExists: false, folderExists: false, bytes: 1024 }),
      row({ id: 2, fileExists: false, folderExists: false, bytes: 2048 }),
    ]);
    expect(report.bytes).toBe(3072);
    expect(report.shows[0].bytes).toBe(3072);
  });

  it('calls a whole absent folder a folder_missing, which no rebuild can repair', () => {
    // The shared-database case: uploaded under the other MEDIA_ROOT, so the
    // bytes are not in this archive to be reindexed.
    const report = groupMissing([row({ fileExists: false, folderExists: false })]);
    expect(report.shows).toHaveLength(1);
    expect(report.shows[0].kind).toBe('folder_missing');
  });

  it('calls a present folder with an absent file drift, which a rebuild does repair', () => {
    const report = groupMissing([row({ fileExists: false, folderExists: true })]);
    expect(report.shows[0].kind).toBe('file_missing');
  });

  it('gathers a festival night into one group rather than forty findings', () => {
    const night = Array.from({ length: 40 }, (_, i) => row({
      id: i + 1, filename: `IMG_${i}.jpg`, fileExists: false, folderExists: false,
    }));
    const report = groupMissing(night);
    expect(report.shows).toHaveLength(1);
    expect(report.shows[0].rows).toHaveLength(40);
    expect(report.missing).toBe(40);
  });

  it('keeps two shows apart even when both are absent', () => {
    const report = groupMissing([
      row({ id: 1, rel_path: 'user-1/a/IMG_1.jpg', fileExists: false, folderExists: false }),
      row({ id: 2, rel_path: 'user-1/b/IMG_2.jpg', fileExists: false, folderExists: false }),
    ]);
    expect(report.shows.map((g) => g.dir)).toEqual(['user-1/a', 'user-1/b']);
  });

  it('puts the shows that cannot be fixed from here first', () => {
    // Ordered for reading: the group that needs bytes copied is the one that
    // should not scroll off the top behind a list of reindexable drift.
    const report = groupMissing([
      row({ id: 1, rel_path: 'user-1/drifted/IMG_1.jpg', fileExists: false, folderExists: true }),
      row({ id: 2, rel_path: 'user-1/stranded/IMG_2.jpg', fileExists: false, folderExists: false }),
    ]);
    expect(report.shows.map((g) => g.kind)).toEqual(['folder_missing', 'file_missing']);
  });

  it('counts the files that are fine alongside the ones that are not', () => {
    const report = groupMissing([
      row({ id: 1 }),
      row({ id: 2, fileExists: false, folderExists: true }),
    ]);
    expect(report).toMatchObject({ present: 1, missing: 1 });
  });

  it('treats a row with no bytes recorded as zero rather than NaN', () => {
    const report = groupMissing([row({ fileExists: false, folderExists: false, bytes: null })]);
    expect(report.bytes).toBe(0);
  });

  it('accepts no rows at all', () => {
    expect(groupMissing([])).toMatchObject({ present: 0, missing: 0, shows: [] });
    expect(groupMissing(undefined)).toMatchObject({ present: 0, missing: 0, shows: [] });
  });
});

describe('showLabel', () => {
  it('names the night and where it was', () => {
    expect(showLabel(row())).toBe('2026-06-12 — Sentrum Scene, Oslo');
  });

  it('slices the date rather than parsing it', () => {
    // concert_date is a calendar day. Read through a local Date, a midnight show
    // slides into the previous day for anyone west of UTC.
    expect(showLabel(row({
      attendance_rel: {
        wishlist_rel: { user_id: 'u' },
        concert_rel: { concert_date: '2026-01-01T00:00:00.000Z', venue: 'V', city: 'C' },
      },
    }))).toContain('2026-01-01');
  });

  it('says what it can when the venue is unknown', () => {
    expect(showLabel(row({
      attendance_rel: { wishlist_rel: { user_id: 'u' }, concert_rel: { concert_date: '2026-06-12' } },
    }))).toBe('2026-06-12');
  });

  it('does not throw on a row whose show could not be joined', () => {
    expect(showLabel(row({ attendance_rel: null }))).toBe('unknown show');
  });
});
