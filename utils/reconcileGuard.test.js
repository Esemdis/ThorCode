import { describe, it, expect } from 'vitest';
import { shouldRefuseReconcile } from './reconcileGuard.js';

describe('shouldRefuseReconcile', () => {
  it('refuses when nine of ten future shows would go', () => {
    expect(shouldRefuseReconcile(9, 10)).toBe(true);
  });

  it('allows exactly half, because only strictly more than half is refused', () => {
    expect(shouldRefuseReconcile(5, 10)).toBe(false);
  });

  it('refuses two of three, the smallest schedule the guard covers', () => {
    expect(shouldRefuseReconcile(2, 3)).toBe(true);
  });

  it('allows two of two, since under three shows a real cancellation looks the same', () => {
    expect(shouldRefuseReconcile(2, 2)).toBe(false);
  });

  it('allows nothing against nothing', () => {
    expect(shouldRefuseReconcile(0, 0)).toBe(false);
  });
});
