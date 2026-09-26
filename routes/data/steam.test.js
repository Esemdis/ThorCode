import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

// The router's own copy of axios; see tmdb.test.js.
const axios = createRequire(import.meta.url)('axios');

const prisma = installFakePrisma({
  user: { findFirst: vi.fn(), update: vi.fn() },
  gameTime: { findFirst: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  game: { upsert: vi.fn() },
});

const { default: router } = await import('./steam.js');
const app = buildApp(router);

const STEAM_ID = '76561198012345678';

beforeEach(() => {
  prisma.user.findFirst.mockResolvedValue(null);
  prisma.user.update.mockResolvedValue({});
  prisma.gameTime.findFirst.mockResolvedValue(null);
  prisma.gameTime.upsert.mockResolvedValue({});
  prisma.gameTime.deleteMany.mockResolvedValue({ count: 0 });
  prisma.game.upsert.mockImplementation(async ({ create }) => ({ id: 1, ...create }));
  vi.spyOn(axios, 'get').mockResolvedValue({
    data: { response: { games: [{ appid: 620, name: 'Portal 2', playtime_forever: 1200 }] } },
  });
});

describe('POST /data/steam/:id', () => {
  it('looks the id up and stores it as a BigInt, whole', async () => {
    // parseInt made this 76561198012345680: a JavaScript number cannot hold it.
    await request(app).post(`/${STEAM_ID}`).set(...authHeader()).expect(200);

    expect(prisma.user.findFirst.mock.calls[0][0].where.steam_id).toBe(76561198012345678n);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' }, data: { steam_id: 76561198012345678n },
    });
  });

  it('refuses anything that is not a 17-digit SteamID64', async () => {
    for (const id of ['12345', '7656119801234567x', '765611980123456789']) {
      await request(app).post(`/${id}`).set(...authHeader()).expect(400);
    }
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('answers 409 when another account already has the id', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'user-2' });

    const res = await request(app).post(`/${STEAM_ID}`).set(...authHeader()).expect(409);

    expect(res.body.error).toMatch(/already linked/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('answers 409, and writes no games, when it loses the race for the id', async () => {
    prisma.user.update.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    await request(app).post(`/${STEAM_ID}`).set(...authHeader()).expect(409);

    expect(prisma.gameTime.upsert).not.toHaveBeenCalled();
  });
});
