import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

// THO-971: POST /bands with an over-long name. A file of its own because
// POST /bands sits behind a per-IP limiter of ten a minute, and bands.test.js
// already spends that whole budget; two more requests there push a later test
// into a 429.
const prisma = installFakePrisma({
  band: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  wishlist: { findUnique: vi.fn(), findFirst: vi.fn() },
  wishlistBandReference: { create: vi.fn() },
});

const { default: router } = await import('./bands.js');
const app = buildApp(router);
// The router's own copy of band creation: CommonJS, loaded through Node's
// require, which an ESM import does not share.
const bandCreate = createRequire(import.meta.url)('../../utils/bandCreate.js');

beforeEach(() => { vi.clearAllMocks(); });

describe('POST /bands with an over-long name (THO-971)', () => {
  it('refuses a name over 200 characters with 400 and reads or creates no band', async () => {
    // Counted after trim, so the spaces around it do not count, and the ones
    // inside do: this is 302 characters.
    const res = await request(app).post('/bands').set(...authHeader()).send({ name: `  a${' '.repeat(300)}b  ` });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'name must be at most 200 characters' });
    expect(prisma.band.findMany).not.toHaveBeenCalled();
    expect(prisma.band.create).not.toHaveBeenCalled();
  });

  it('answers 400 with the cap when band creation refuses the name', async () => {
    vi.spyOn(bandCreate, 'createBand').mockRejectedValue(new bandCreate.BandNameTooLongError());

    const res = await request(app).post('/bands').set(...authHeader()).send({ name: 'Architects' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'name must be at most 200 characters' });
  });

  it('still lets a 200-character name through to band creation', async () => {
    const name = 'a'.repeat(200);
    vi.spyOn(bandCreate, 'createBand').mockResolvedValue({
      band: { id: 7, name, MBID: null }, songkickUrl: null, bandsintownUrl: null, warning: null,
    });

    const res = await request(app).post('/bands').set(...authHeader()).send({ name: `  ${name}  ` });

    expect(res.status).toBe(201);
    expect(bandCreate.createBand).toHaveBeenCalledWith(name);
  });
});
