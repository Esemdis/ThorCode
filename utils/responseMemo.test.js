import { describe, it, expect, vi, afterEach } from 'vitest';
import { createResponseMemo } from './responseMemo.js';

afterEach(() => { vi.useRealTimers(); });

describe('createResponseMemo', () => {
  it('answers a second call inside the window without computing again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
    const memo = createResponseMemo({ ttlMs: 60_000 });
    const compute = vi.fn(async () => ['opeth']);

    expect(await memo.get('k', compute)).toEqual(['opeth']);
    vi.setSystemTime(new Date('2026-10-19T12:00:59Z'));
    expect(await memo.get('k', compute)).toEqual(['opeth']);

    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('computes again once the window has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
    const memo = createResponseMemo({ ttlMs: 60_000 });
    const compute = vi.fn(async () => 1);

    await memo.get('k', compute);
    vi.setSystemTime(new Date('2026-10-19T12:01:00Z'));
    await memo.get('k', compute);

    expect(compute).toHaveBeenCalledTimes(2);
  });

  // The point of storing the promise: a burst arriving during one cold
  // computation must not each start their own whole-table scans.
  it('shares one computation between calls that arrive while it is still running', async () => {
    const memo = createResponseMemo({ ttlMs: 60_000 });
    let release;
    const compute = vi.fn(() => new Promise((resolve) => { release = resolve; }));

    const first = memo.get('k', compute);
    const second = memo.get('k', compute);
    await Promise.resolve();
    release('done');

    expect(await Promise.all([first, second])).toEqual(['done', 'done']);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failure, so the next call tries again', async () => {
    const memo = createResponseMemo({ ttlMs: 60_000 });
    const compute = vi.fn()
      .mockRejectedValueOnce(new Error('database went away'))
      .mockResolvedValueOnce('ok');

    await expect(memo.get('k', compute)).rejects.toThrow('database went away');
    expect(await memo.get('k', compute)).toBe('ok');
  });

  it('drops a compute that throws before returning a promise', async () => {
    const memo = createResponseMemo({ ttlMs: 60_000 });
    const compute = vi.fn()
      .mockImplementationOnce(() => { throw new Error('boom'); })
      .mockResolvedValueOnce('ok');

    await expect(memo.get('k', compute)).rejects.toThrow('boom');
    expect(await memo.get('k', compute)).toBe('ok');
  });

  it('keeps separate keys apart', async () => {
    const memo = createResponseMemo({ ttlMs: 60_000 });

    expect(await memo.get('a', async () => 'A')).toBe('A');
    expect(await memo.get('b', async () => 'B')).toBe('B');
  });
});
