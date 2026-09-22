import { describe, it, expect, vi } from 'vitest';
import { serialise, acquire } from './serialQueue.js';

const defer = () => { let r; const p = new Promise((res) => { r = res; }); return { p, resolve: r }; };
// A fresh key per test. The queue is module state, so a test that leaves work
// unresolved on a shared key wedges every test after it — which is exactly
// what the first draft of this file did to itself.
let n = 0;
const key = () => `k${n++}`;
// The chain is prev.then().then(fn), so `fn` is two microtask hops away.
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('serialise', () => {
  it('does not start the second run until the first has finished', async () => {
    const k = key();
    const order = [];
    const first = defer();

    const a = serialise(k, async () => { order.push('a:start'); await first.p; order.push('a:end'); });
    const b = serialise(k, async () => { order.push('b:start'); });

    await settle();
    expect(order).toEqual(['a:start']);

    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('lets different keys run at the same time', async () => {
    // The whole point of keying it: one busy show must not hold up another.
    const order = [];
    const first = defer();

    const a = serialise(key(), async () => { order.push('a:start'); await first.p; });
    await serialise(key(), async () => { order.push('b:start'); });

    expect(order).toEqual(['a:start', 'b:start']);
    first.resolve();
    await a;
  });

  it('keeps running later work after one run throws', async () => {
    // Chaining on success alone would let a single failure wedge every later
    // run for that key, permanently, for the life of the process.
    const k = key();
    await expect(serialise(k, async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    await expect(serialise(k, async () => 'fine')).resolves.toBe('fine');
  });

  it('hands back what the work returned', async () => {
    await expect(serialise(key(), async () => 42)).resolves.toBe(42);
  });

  it('runs immediately on a key whose earlier work has settled', async () => {
    // A long-lived process must not accumulate an entry per show it has ever
    // touched, and a settled key must not make later work wait.
    const k = key();
    await serialise(k, async () => {});
    const started = vi.fn();
    await serialise(k, async () => { started(); });
    expect(started).toHaveBeenCalled();
  });
});

describe('acquire', () => {
  it('makes the second caller wait for the first to release', async () => {
    const k = key();
    const order = [];

    const release = await acquire(k);
    order.push('first:held');

    let secondHeld = false;
    const second = acquire(k).then((r) => { secondHeld = true; return r; });

    await settle();
    expect(secondHeld).toBe(false);

    release();
    const releaseSecond = await second;
    expect(secondHeld).toBe(true);
    releaseSecond();
    expect(order).toEqual(['first:held']);
  });

  it('does not make one key wait on another', async () => {
    const a = await acquire(key());
    // Would hang here if the lock were global rather than per key.
    const b = await acquire(key());
    a(); b();
  });

  it('hands the lock on even when the holder released from a failing path', async () => {
    // The route releases in a finally, so this is the normal case after an
    // upload throws. A lock not handed on would wedge that show forever.
    const k = key();
    const release = await acquire(k);
    try {
      throw new Error('upload blew up');
    } catch {
      release();
    }
    const next = await acquire(k);
    expect(typeof next).toBe('function');
    next();
  });
});
