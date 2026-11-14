import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// THO-1003: the per-key count of open album downloads.

const require = createRequire(import.meta.url);
const { createSlotCounter } = require('./openSlots.js');

describe('createSlotCounter', () => {
  it('hands out slots up to the cap and then refuses', () => {
    const slots = createSlotCounter({ max: 2 });
    expect(slots.tryAcquire('album')).toBeTypeOf('function');
    expect(slots.tryAcquire('album')).toBeTypeOf('function');
    expect(slots.tryAcquire('album')).toBeNull();
  });

  it('frees a slot on release, so the next caller gets in', () => {
    const slots = createSlotCounter({ max: 1 });
    const release = slots.tryAcquire('album');
    expect(slots.tryAcquire('album')).toBeNull();
    release();
    expect(slots.tryAcquire('album')).toBeTypeOf('function');
  });

  it('counts a release once however often it is called', () => {
    // A response fires both 'finish' and 'close', and both release. Counting
    // the second would free someone else's slot and let the key past its cap.
    const slots = createSlotCounter({ max: 2 });
    const first = slots.tryAcquire('album');
    slots.tryAcquire('album');
    first();
    first();
    expect(slots.tryAcquire('album')).toBeTypeOf('function');
    expect(slots.tryAcquire('album')).toBeNull();
  });

  it('forgets a key once its last slot is released', () => {
    const slots = createSlotCounter({ max: 3 });
    const a = slots.tryAcquire('album');
    const b = slots.tryAcquire('album');
    expect(slots.size()).toBe(1);
    a();
    expect(slots.size()).toBe(1);
    b();
    expect(slots.size()).toBe(0);
  });

  it('keeps each key to its own count', () => {
    const slots = createSlotCounter({ max: 1 });
    expect(slots.tryAcquire('one')).toBeTypeOf('function');
    expect(slots.tryAcquire('two')).toBeTypeOf('function');
    expect(slots.tryAcquire('one')).toBeNull();
    expect(slots.size()).toBe(2);
  });

  it('does not create an entry for a refused key', () => {
    const slots = createSlotCounter({ max: 0 });
    expect(slots.tryAcquire('album')).toBeNull();
    expect(slots.size()).toBe(0);
  });
});
