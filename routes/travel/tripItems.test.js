import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

const prisma = installFakePrisma({
  trip: { findFirst: vi.fn(async () => ({ id: 1 })) },
  tripItem: { update: vi.fn(async ({ data }) => ({ id: 9, ...data })) },
  gearItem: { findFirst: vi.fn(async () => null) },
});

const { default: router } = await import('./tripItems.js');
const app = () => buildApp(router, '/travel/trips/:tripId/items');

beforeEach(() => {
  prisma.trip.findFirst = vi.fn(async () => ({ id: 1 }));
  prisma.tripItem.update = vi.fn(async ({ data }) => ({ id: 9, ...data }));
  // Nothing of the caller's matches: the gear id they are asking for belongs
  // to somebody else, which is what findFirst scoped by user_id returns.
  prisma.gearItem.findFirst = vi.fn(async () => null);
});

describe('linking a trip item to a gear item that is not yours', () => {
  // POST has always scoped the gear lookup to the caller. PATCH did not, and
  // answered with `include: { gear_item_rel: true }` — the whole GearItem row,
  // including its `photo`, a base64 data URL of the item. Gear ids are
  // sequential, so walking them returned every account's kit list.
  it('refuses the link rather than joining in a stranger\'s gear', async () => {
    const res = await request(app())
      .patch('/travel/trips/1/items/9')
      .set(...authHeader({ id: 'user-1' }))
      .send({ gear_item_id: 1234 });

    expect(res.status).toBe(404);
    expect(prisma.tripItem.update).not.toHaveBeenCalled();
  });

  it('checks the gear against the caller, not merely that it exists', async () => {
    await request(app())
      .patch('/travel/trips/1/items/9')
      .set(...authHeader({ id: 'user-1' }))
      .send({ gear_item_id: 1234 });

    expect(prisma.gearItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 1234, user_id: 'user-1' }),
    }));
  });

  it('allows a link to gear the caller does own', async () => {
    prisma.gearItem.findFirst = vi.fn(async () => ({ id: 77, worn: false }));

    const res = await request(app())
      .patch('/travel/trips/1/items/9')
      .set(...authHeader({ id: 'user-1' }))
      .send({ gear_item_id: 77 })
      .expect(200);

    expect(res.body.data.gear_item_id).toBe(77);
  });

  it('still lets a link be cleared, which owns nothing', async () => {
    // null means "unlink". Sending it through the ownership check would 404
    // every attempt to detach an item from its gear.
    await request(app())
      .patch('/travel/trips/1/items/9')
      .set(...authHeader({ id: 'user-1' }))
      .send({ gear_item_id: null })
      .expect(200);

    expect(prisma.gearItem.findFirst).not.toHaveBeenCalled();
  });

  it('leaves an edit that never mentions gear alone', async () => {
    await request(app())
      .patch('/travel/trips/1/items/9')
      .set(...authHeader({ id: 'user-1' }))
      .send({ name: 'Rain shell' })
      .expect(200);

    expect(prisma.gearItem.findFirst).not.toHaveBeenCalled();
  });
});

describe('PATCH /travel/trips/:tripId/items/reorder', () => {
  it('answers a malformed entry with 400 rather than failing the transaction as a 500', async () => {
    prisma.$transaction = vi.fn(async (ops) => Promise.all(ops));
    prisma.tripItem.updateMany = vi.fn(async () => ({ count: 1 }));

    const res = await request(app())
      .patch('/travel/trips/1/items/reorder')
      .set(...authHeader({ id: 'user-1' }))
      .send({ items: [{ id: 1, sort_order: 0 }, { id: 'two', sort_order: 1 }] });

    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reorders within this trip only', async () => {
    prisma.$transaction = vi.fn(async (ops) => Promise.all(ops));
    prisma.tripItem.updateMany = vi.fn(async () => ({ count: 1 }));

    const res = await request(app())
      .patch('/travel/trips/1/items/reorder')
      .set(...authHeader({ id: 'user-1' }))
      .send({ items: [{ id: '5', sort_order: 2 }] });

    expect(res.status).toBe(200);
    expect(prisma.tripItem.updateMany).toHaveBeenCalledWith({ where: { id: 5, trip_id: 1 }, data: { sort_order: 2 } });
  });
});

describe('PATCH an item\'s text fields', () => {
  const patch = (body) => request(app())
    .patch('/travel/trips/1/items/9')
    .set(...authHeader({ id: 'user-1' }))
    .send(body);

  // POST requires a name; PATCH saved "" as one, and .trim() on a null or a
  // number threw before the try and answered 500.
  it.each([
    ['an empty name', { name: '' }, 'name'],
    ['a blank name', { name: '   ' }, 'name'],
    ['a null name', { name: null }, 'name'],
    ['a numeric category', { category: 5 }, 'category'],
    ['a numeric note', { note: 5 }, 'note'],
    ['an object url', { url: {} }, 'url'],
  ])('refuses %s with a 400 that names the field', async (_, body, field) => {
    const res = await patch(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(field);
    expect(prisma.tripItem.update).not.toHaveBeenCalled();
  });

  it('still renames, trimmed', async () => {
    const res = await patch({ name: '  Rain shell  ' }).expect(200);

    expect(res.body.data.name).toBe('Rain shell');
  });

  it('still clears a note with null, and a blank category to null', async () => {
    await patch({ note: null, category: '  ' }).expect(200);

    expect(prisma.tripItem.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { note: null, category: null },
    }));
  });

  it('keeps the old message for an item id that is not a number', async () => {
    const res = await request(app())
      .patch('/travel/trips/1/items/abc')
      .set(...authHeader({ id: 'user-1' }))
      .send({ name: 'Rain shell' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid parameters');
  });
});

describe('a gear id that is not a number', () => {
  it('is a 400, not a Prisma error', async () => {
    const res = await request(app())
      .patch('/travel/trips/1/items/9')
      .set(...authHeader({ id: 'user-1' }))
      .send({ gear_item_id: 'abc' });

    expect(res.status).toBe(400);
    expect(prisma.gearItem.findFirst).not.toHaveBeenCalled();
  });

  it.each([true, '1e3', '5.5', -3])('is refused as %j, which parseInt would misread', async (value) => {
    const res = await request(app())
      .patch('/travel/trips/1/items/9')
      .set(...authHeader({ id: 'user-1' }))
      .send({ gear_item_id: value });

    expect(res.status).toBe(400);
    expect(prisma.gearItem.findFirst).not.toHaveBeenCalled();
  });
});

describe('PATCH /travel/trips/:tripId/items/bulk (THO-654)', () => {
  const bulkPatchTho654 = (body) => request(app())
    .patch('/travel/trips/1/items/bulk')
    .set(...authHeader({ id: 'user-1' }))
    .send(body);

  it('sets one status on every listed item of this trip in one update', async () => {
    prisma.tripItem.count = vi.fn(async () => 3);
    prisma.tripItem.updateMany = vi.fn(async () => ({ count: 3 }));

    const res = await bulkPatchTho654({ ids: [4, '5', 6, 4], status: 'PACKED' }).expect(200);

    expect(res.body.data).toEqual({ ids: [4, 5, 6], status: 'PACKED' });
    expect(prisma.tripItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [4, 5, 6] }, trip_id: 1 },
      data: { status: 'PACKED' },
    });
  });

  it('refuses the whole request when an id is not on this trip', async () => {
    prisma.tripItem.count = vi.fn(async () => 1);
    prisma.tripItem.updateMany = vi.fn(async () => ({ count: 1 }));

    const res = await bulkPatchTho654({ ids: [4, 999], status: 'PACKED' });

    expect(res.status).toBe(404);
    expect(prisma.tripItem.count).toHaveBeenCalledWith({ where: { id: { in: [4, 999] }, trip_id: 1 } });
    expect(prisma.tripItem.updateMany).not.toHaveBeenCalled();
  });

  it('answers 404 for somebody else\'s trip before touching items', async () => {
    prisma.trip.findFirst = vi.fn(async () => null);
    prisma.tripItem.updateMany = vi.fn();

    expect((await bulkPatchTho654({ ids: [4], status: 'PACKED' })).status).toBe(404);
    expect(prisma.tripItem.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    [{ ids: [4], status: 'LOST' }],
    [{ ids: [], status: 'PACKED' }],
    [{ ids: 4, status: 'PACKED' }],
    [{ ids: [4, 'x'], status: 'PACKED' }],
    [{ ids: [0], status: 'PACKED' }],
  ])('answers 400 for %j', async (body) => {
    prisma.tripItem.updateMany = vi.fn();
    expect((await bulkPatchTho654(body)).status).toBe(400);
    expect(prisma.tripItem.updateMany).not.toHaveBeenCalled();
  });
});
