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
