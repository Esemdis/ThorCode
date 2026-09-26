import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

// Seeded before the router is imported — see installFakePrisma.
const prisma = installFakePrisma({ city: { update: vi.fn() } });
const { default: router } = await import('./cities.js');
const app = buildApp(router);

describe('PATCH /data/cities/:id', () => {
  it('answers 404 for a city that does not exist, rather than 500', async () => {
    prisma.city.update.mockRejectedValue(Object.assign(new Error('not found'), { code: 'P2025' }));

    const res = await request(app).patch('/404').set(...authHeader({ role: 'ADMIN' })).send({ reachable: true });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'City not found' });
  });
});
