import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

const prisma = installFakePrisma({
  travelWishlistItem: { updateMany: vi.fn(), update: vi.fn() },
  gearItem: { create: vi.fn(async () => ({ id: 1 })) },
  $transaction: vi.fn(async (fn) => fn(prisma)),
});

const { default: router } = await import('./wishlist.js');
const app = buildApp(router, '/travel/wishlist');

const ITEM = { id: 3, name: 'Tent', brand: 'Hilleberg', model: 'Akto', category: 'Shelter', url: null, notes: null, dimensions: null, keywords: ['tent'] };

describe('ticking an item as bought', () => {
  beforeEach(() => {
    prisma.travelWishlistItem.update.mockResolvedValue({ ...ITEM, bought: true });
  });

  it('adds it to the gear closet on the transition', async () => {
    prisma.travelWishlistItem.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).patch('/travel/wishlist/3').set(...authHeader({ id: 'user-1' })).send({ bought: true });

    expect(res.status).toBe(200);
    expect(prisma.travelWishlistItem.updateMany).toHaveBeenCalledWith({
      where: { id: 3, user_id: 'user-1', bought: false },
      data: { bought: true },
    });
    expect(prisma.gearItem.create).toHaveBeenCalledTimes(1);
  });

  it('does not add it twice when the transition was someone else\'s', async () => {
    // Two ticks at once both used to read "not bought" and each create a gear
    // row. The conditional write lets only one of them match.
    prisma.travelWishlistItem.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app).patch('/travel/wishlist/3').set(...authHeader({ id: 'user-1' })).send({ bought: true });

    expect(res.status).toBe(200);
    expect(prisma.gearItem.create).not.toHaveBeenCalled();
  });

  it('answers 404 for an item that is not the caller\'s', async () => {
    prisma.travelWishlistItem.updateMany.mockResolvedValue({ count: 0 });
    prisma.travelWishlistItem.update.mockRejectedValue(Object.assign(new Error('not found'), { code: 'P2025' }));

    const res = await request(app).patch('/travel/wishlist/3').set(...authHeader({ id: 'user-1' })).send({ bought: true });

    expect(res.status).toBe(404);
    expect(prisma.gearItem.create).not.toHaveBeenCalled();
  });
});
