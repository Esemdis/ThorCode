import { describe, it, expect } from 'vitest';
import { groupDuplicates, redundantBytes } from './mediaDuplicates.js';

const row = (id, attendance_id, sha256, bytes = 100) => ({ id, attendance_id, sha256, bytes });

describe('groupDuplicates', () => {
  it('groups byte-identical files within one show', () => {
    const groups = groupDuplicates([row(1, 1, 'aaa'), row(2, 1, 'aaa'), row(3, 1, 'bbb')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((r) => r.id)).toEqual([1, 2]);
  });

  it('does not call the same bytes under two shows a duplicate', () => {
    // Two people at one gig, or one person's record of two nights. Neither is
    // a redundant copy, and deleting one would take a real file from a real
    // show.
    expect(groupDuplicates([row(1, 1, 'aaa'), row(2, 2, 'aaa')])).toEqual([]);
  });

  it('skips a row with no checksum rather than grouping it under null', () => {
    // Grouped on a shared null, every unhashed file in a show would be
    // reported as copies of each other.
    expect(groupDuplicates([row(1, 1, null), row(2, 1, null), row(3, 1, undefined)])).toEqual([]);
  });

  it('puts the oldest row first, because that is the one to keep', () => {
    // The sidecar entry and any tags are attached to the row that was written
    // first, so the advice the report prints has to point at it.
    const groups = groupDuplicates([row(9, 1, 'aaa'), row(2, 1, 'aaa'), row(5, 1, 'aaa')]);
    expect(groups[0].map((r) => r.id)).toEqual([2, 5, 9]);
  });

  it('reports the worst offenders first', () => {
    const groups = groupDuplicates([
      row(1, 1, 'aaa'), row(2, 1, 'aaa'),
      row(3, 1, 'bbb'), row(4, 1, 'bbb'), row(5, 1, 'bbb'),
    ]);
    expect(groups.map((g) => g.length)).toEqual([3, 2]);
  });

  it('finds nothing in an archive with nothing wrong with it', () => {
    expect(groupDuplicates([row(1, 1, 'aaa'), row(2, 1, 'bbb')])).toEqual([]);
    expect(groupDuplicates([])).toEqual([]);
  });
});

describe('redundantBytes', () => {
  it('counts every copy but the one being kept', () => {
    const groups = groupDuplicates([row(1, 1, 'aaa', 500), row(2, 1, 'aaa', 500), row(3, 1, 'aaa', 500)]);
    expect(redundantBytes(groups)).toBe(1000);
  });

  it('treats a row with no recorded size as nothing rather than NaN', () => {
    // One unsized row would otherwise turn the whole total into "NaN MB".
    const groups = groupDuplicates([row(1, 1, 'aaa', 500), { id: 2, attendance_id: 1, sha256: 'aaa' }]);
    expect(redundantBytes(groups)).toBe(0);
  });
});
