import { describe, it, expect } from 'vitest';
import { sumCounts } from './bulkCounts.js';

describe('sumCounts', () => {
  it('adds up the rows each updateMany actually matched', () => {
    expect(sumCounts([{ count: 1 }, { count: 1 }, { count: 1 }])).toBe(3);
  });

  // A trip deleted between the pending read and the PATCH matches nothing.
  // Counting ids instead would report it as written.
  it('does not count an id whose row has gone', () => {
    expect(sumCounts([{ count: 1 }, { count: 0 }, { count: 1 }])).toBe(2);
  });

  it('is zero for an empty chunk', () => {
    expect(sumCounts([])).toBe(0);
  });
});
