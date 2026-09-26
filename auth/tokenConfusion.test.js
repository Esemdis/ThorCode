import { describe, it, expect, vi, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { authHeader, installFakePrisma } from '../test/routeApp.js';

// The end-to-end version of the hole: an OAuth state, lifted out of the URL the
// API hands a signed-in user, presented back to the API as a bearer token. It
// used to verify — same secret — with no `id` and no `role`, and every route
// that scopes by `where: { user_id: req.user.id }` then ran with no user filter
// at all. Reproduced against Postgres: another account's trips listed and one
// deleted, every wishlist's Discord webhook and calendar token returned, every
// user's Spotify connection removed.
const prisma = installFakePrisma({
  trip: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0), delete: vi.fn() },
  oAuth: { deleteMany: vi.fn(async () => ({ count: 0 })), findUnique: vi.fn() },
});

const { default: spotifyRouter } = await import('../routes/oauth/spotify.js');
const { default: tripsRouter } = await import('../routes/travel/trips.js');

const app = express();
app.use(express.json());
app.use('/oauth/spotify', spotifyRouter);
app.use('/travel/trips', tripsRouter);

let state;

beforeAll(async () => {
  process.env.SPOTIFY_CLIENT_ID = 'client-id';
  process.env.SPOTIFY_CLIENT_SECRET = 'client-secret';
  process.env.CALLBACK_URL = 'https://api.example.test';

  const res = await request(app).get('/oauth/spotify/authorize-url').set(...authHeader({ id: 'attacker' }));
  expect(res.status).toBe(200);
  state = new URL(res.body.url).searchParams.get('state');
  expect(state).toBeTruthy();
});

describe('an OAuth state presented as a bearer token', () => {
  it('cannot list trips', async () => {
    const res = await request(app).get('/travel/trips').set('Authorization', `Bearer ${state}`);

    expect(res.status).toBe(401);
    expect(prisma.trip.findMany).not.toHaveBeenCalled();
  });

  it('cannot delete a trip', async () => {
    const res = await request(app).delete('/travel/trips/1').set('Authorization', `Bearer ${state}`);

    expect(res.status).toBe(401);
    expect(prisma.trip.delete).not.toHaveBeenCalled();
  });

  it('cannot disconnect Spotify', async () => {
    const res = await request(app).delete('/oauth/spotify').set('Authorization', `Bearer ${state}`);

    expect(res.status).toBe(401);
    expect(prisma.oAuth.deleteMany).not.toHaveBeenCalled();
  });

  it('while the login it was minted for still works', async () => {
    const res = await request(app).get('/travel/trips').set(...authHeader({ id: 'attacker' }));

    expect(res.status).toBe(200);
    expect(prisma.trip.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { user_id: 'attacker' },
    }));
  });
});
