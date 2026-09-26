import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

// Seeded before the routers are imported — see installFakePrisma. One fake for
// the four closet routers, since what is under test is the same thing in each:
// that a malformed body is answered before anything reaches the database.
const prisma = installFakePrisma({
  gearItem: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
  loadout: { create: vi.fn(), update: vi.fn() },
  expenseEstimate: { create: vi.fn(), update: vi.fn() },
  tripTodo: { create: vi.fn(), update: vi.fn() },
  trip: { findFirst: vi.fn() },
  $transaction: vi.fn(async (ops) => Promise.all(ops)),
});

const gear = buildApp((await import('./gear.js')).default);
const loadouts = buildApp((await import('./loadouts.js')).default);
// Mounted as index.js mounts them, so ownsTrip sees :tripId.
const estimates = buildApp((await import('./estimates.js')).default, '/trips/:tripId/estimates');
const todos = buildApp((await import('./tripTodos.js')).default, '/trips/:tripId/todos');

const user = authHeader({ id: 'user-1' });

beforeEach(() => {
  prisma.gearItem.create.mockImplementation(async ({ data }) => ({ id: 3, ...data }));
  prisma.gearItem.update.mockImplementation(async ({ data }) => ({ id: 3, ...data }));
  prisma.gearItem.updateMany.mockResolvedValue({ count: 1 });
  prisma.gearItem.findFirst.mockResolvedValue({ id: 3, name: 'Bag', brand: 'Osprey', model: null });
  prisma.trip.findFirst.mockResolvedValue({ id: 5 });
});

describe('POST /travel/gear', () => {
  it('creates the item from the normalised form, as the caller\'s', async () => {
    const res = await request(gear).post('/').set(...user)
      .send({ name: ' Bag ', currency: 'eur', retail_price: '12.50', tags: ['a '] });

    expect(res.status).toBe(201);
    expect(prisma.gearItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        user_id: 'user-1', name: 'Bag', currency: 'EUR', retail_price: 12.5, tags: ['a'],
      }),
    });
  });

  it('answers a fill level that is not a number with 400, not a 500 from Prisma', async () => {
    const res = await request(gear).post('/').set(...user).send({ name: 'Bag', fill_level: 'full' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fill_level/);
    expect(prisma.gearItem.create).not.toHaveBeenCalled();
  });
});

describe('PATCH /travel/gear/:id', () => {
  it('renames every copy of the same product, found by what it was called before', async () => {
    const res = await request(gear).patch('/3').set(...user).send({ name: 'Daypack' });

    expect(res.status).toBe(200);
    expect(prisma.gearItem.updateMany).toHaveBeenCalledWith({
      where: { user_id: 'user-1', id: { not: 3 }, name: 'Bag', brand: 'Osprey', model: null },
      data: { name: 'Daypack' },
    });
  });

  it('keeps a per-copy change to the one copy', async () => {
    await request(gear).patch('/3').set(...user).send({ fill_level: 30 }).expect(200);

    expect(prisma.gearItem.update).toHaveBeenCalledWith({
      where: { id: 3, user_id: 'user-1' }, data: { fill_level: 30 },
    });
    expect(prisma.gearItem.updateMany).not.toHaveBeenCalled();
  });

  it('answers a name that is not text with 400; .trim() on it was a 500', async () => {
    const res = await request(gear).patch('/3').set(...user).send({ name: 12 });

    expect(res.status).toBe(400);
    expect(prisma.gearItem.update).not.toHaveBeenCalled();
  });
});

describe('the other closet routes, given a body they cannot store', () => {
  it('refuses a loadout budget that is not a whole number', async () => {
    const res = await request(loadouts).patch('/2').set(...user).send({ weight_budget: 'heavy' });

    expect(res.status).toBe(400);
    expect(prisma.loadout.update).not.toHaveBeenCalled();
  });

  it('refuses an estimate edit with an amount that is not a number', async () => {
    // The edit route validated nothing, so this reached Prisma as NaN.
    const res = await request(estimates).patch('/trips/5/estimates/8').set(...user).send({ amount: 'lots' });

    expect(res.status).toBe(400);
    expect(prisma.expenseEstimate.update).not.toHaveBeenCalled();
  });

  it('refuses an estimate with a date that does not parse', async () => {
    const res = await request(estimates).post('/trips/5/estimates').set(...user)
      .send({ category: 'Food', amount: 50, date: 'soonish' });

    expect(res.status).toBe(400);
    expect(prisma.expenseEstimate.create).not.toHaveBeenCalled();
  });

  it('refuses todo text that is not a string, and a sort position that is not whole', async () => {
    const text = await request(todos).patch('/trips/5/todos/4').set(...user).send({ text: 12 });
    const order = await request(todos).patch('/trips/5/todos/4').set(...user).send({ sort_order: 'top' });

    expect([text.status, order.status]).toEqual([400, 400]);
    expect(prisma.tripTodo.update).not.toHaveBeenCalled();
  });
});
