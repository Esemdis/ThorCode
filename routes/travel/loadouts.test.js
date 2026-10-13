import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

// Three gear items, so a partial overlap has something to overlap with.
const ENTRIES = [
  { gear_item_id: 11, worn: false, bag_id: null, gear_item_rel: { name: 'Rain shell', category: 'Clothing' } },
  { gear_item_id: 22, worn: true, bag_id: null, gear_item_rel: { name: 'Boots', category: 'Footwear' } },
  { gear_item_id: 33, worn: false, bag_id: 5, gear_item_rel: { name: 'Headtorch', category: 'Light' } },
];

// The trip's packing list, kept across the calls of one test — what this route
// has to get right is what it does with the rows that are already there, and a
// fake that answers every read with the same thing cannot show that.
let packed;
let nextId;

const prisma = installFakePrisma({
  loadout: { findFirst: vi.fn() },
  trip: { findFirst: vi.fn() },
  tripItem: { findMany: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
});

const { default: router } = await import('./loadouts.js');
const app = () => buildApp(router, '/travel/loadouts');

const apply = () => request(app())
  .post('/travel/loadouts/1/apply/7')
  .set(...authHeader({ id: 'user-1' }));

beforeEach(() => {
  packed = [];
  nextId = 100;
  prisma.loadout.findFirst = vi.fn(async () => ({ id: 1, user_id: 'user-1', entries: ENTRIES }));
  prisma.trip.findFirst = vi.fn(async () => ({ id: 7 }));
  prisma.tripItem.findMany = vi.fn(async ({ where }) => packed
    .filter((item) => item.trip_id === where.trip_id && where.gear_item_id.in.includes(item.gear_item_id))
    .map((item) => ({ gear_item_id: item.gear_item_id })));
  prisma.tripItem.create = vi.fn(async ({ data }) => {
    const row = { id: nextId++, ...data };
    packed.push(row);
    return row;
  });
  prisma.$transaction = vi.fn(async (ops) => Promise.all(ops));
});

describe('POST /travel/loadouts/:id/apply/:tripId', () => {
  it('packs every gear item the loadout names', async () => {
    const res = await apply().expect(200);

    expect(res.body.data.added).toBe(3);
    expect(res.body.data.skipped).toBe(0);
    expect(res.body.data.items.map((item) => item.gear_item_id)).toEqual([11, 22, 33]);
  });

  it('adds nothing the second time, and reports what it left alone', async () => {
    // A double click or a retried request applied the loadout twice over: every
    // item was created again, the list read double and so did the pack weight.
    await apply().expect(200);
    const second = await apply().expect(200);

    expect(second.body.data.added).toBe(0);
    expect(second.body.data.skipped).toBe(3);
    expect(second.body.data.items).toEqual([]);
    expect(packed).toHaveLength(3);
  });

  it('adds only the gear the trip is missing', async () => {
    packed.push({ id: 1, trip_id: 7, gear_item_id: 22, name: 'Boots' });

    const res = await apply().expect(200);

    expect(res.body.data.added).toBe(2);
    expect(res.body.data.skipped).toBe(1);
    expect(res.body.data.items.map((item) => item.gear_item_id)).toEqual([11, 33]);
  });

  it('counts what is packed on this trip only', async () => {
    // Gear ids are shared across a user's trips, so skipping on the gear id
    // alone would answer a fresh trip with "already packed, nothing to do".
    packed.push({ id: 1, trip_id: 8, gear_item_id: 11, name: 'Rain shell' });

    const res = await apply().expect(200);

    expect(prisma.tripItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ trip_id: 7 }),
    }));
    expect(res.body.data.added).toBe(3);
  });

  it('is not stopped by a hand-written item of the same name', async () => {
    // Typed in by the owner, so it has no gear id and nothing links it to the
    // loadout's entry; matching on the name would silently drop that entry.
    packed.push({ id: 1, trip_id: 7, gear_item_id: null, name: 'Rain shell' });

    const res = await apply().expect(200);

    expect(res.body.data.added).toBe(3);
    expect(res.body.data.skipped).toBe(0);
  });

  it('carries the entry\'s own worn flag and bag through', async () => {
    const res = await apply().expect(200);

    expect(res.body.data.items).toEqual([
      expect.objectContaining({ gear_item_id: 11, name: 'Rain shell', category: 'Clothing', status: 'BOUGHT', worn: false, bag_id: null }),
      expect.objectContaining({ gear_item_id: 22, worn: true, bag_id: null }),
      expect.objectContaining({ gear_item_id: 33, worn: false, bag_id: 5 }),
    ]);
  });

  it('serialises two applies of one trip rather than packing it twice', async () => {
    // Both requests are held at the ownership check, which sits in front of the
    // queue, so each is certainly in the handler before either reads the
    // packing list — the double click this is really about. Unqueued they both
    // read nothing packed and both pack the lot.
    let arrived = 0;
    let bothHere;
    const waiting = new Promise((resolve) => { bothHere = resolve; });
    prisma.trip.findFirst = vi.fn(async () => {
      if (++arrived === 2) bothHere();
      await waiting;
      return { id: 7 };
    });

    const [first, second] = await Promise.all([apply(), apply()]);

    expect([first.body.data.added, second.body.data.added].sort()).toEqual([0, 3]);
    expect(packed).toHaveLength(3);
  });

  it('is a 404 for someone else\'s trip, before anything is written', async () => {
    prisma.trip.findFirst = vi.fn(async () => null);

    await apply().expect(404);

    expect(prisma.tripItem.create).not.toHaveBeenCalled();
  });
});
