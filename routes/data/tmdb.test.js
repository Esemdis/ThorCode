import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

// The router's own copy of axios. vi.mock cannot reach a CommonJS require, but
// the router calls axios.get through the module object, so replacing `get` on
// that same object stands in for TMDB without a request leaving the machine.
const axios = createRequire(import.meta.url)('axios');

const prisma = installFakePrisma({
  oAuth: { findUnique: vi.fn() },
  movie: { upsert: vi.fn() },
  movieReview: { upsert: vi.fn(), deleteMany: vi.fn() },
});

const { default: router } = await import('./tmdb.js');
const app = buildApp(router);

const rated = (...movies) => ({ data: { results: movies } });

beforeEach(() => {
  prisma.oAuth.findUnique.mockResolvedValue({ provider_user_id: '42', access_token: 'session' });
  // Our own ids, deliberately far from TMDB's, so a comparison that mixes the
  // two cannot pass by coincidence.
  prisma.movie.upsert.mockImplementation(async ({ where }) => ({ id: where.tmdb_id - 500, name: 'x' }));
  prisma.movieReview.upsert.mockResolvedValue({});
  prisma.movieReview.deleteMany.mockResolvedValue({ count: 0 });
});

describe('POST /me', () => {
  it('keeps the reviews it has just written', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue(rated(
      { id: 603, original_title: 'The Matrix', rating: 9 },
      { id: 680, original_title: 'Pulp Fiction', rating: 8 },
    ));

    await request(app).post('/me').set(...authHeader()).expect(200);

    // Matched on TMDB's id through the relation. It used to be
    // `movie: { notIn: [603, 680] }` — TMDB ids against our Movie.id — which
    // deleted every review the loop above had just upserted.
    expect(prisma.movieReview.deleteMany).toHaveBeenCalledWith({
      where: { user: 'user-1', movie_rel: { tmdb_id: { notIn: [603, 680] } } },
    });
  });

  it('keeps a review whose refresh failed, since TMDB still lists it', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue(rated(
      { id: 603, original_title: 'The Matrix', rating: 9 },
      { id: 680, original_title: 'Pulp Fiction', rating: 8 },
    ));
    prisma.movieReview.upsert
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('connection reset'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await request(app).post('/me').set(...authHeader()).expect(200);

    expect(prisma.movieReview.deleteMany.mock.calls[0][0].where.movie_rel.tmdb_id.notIn).toEqual([603, 680]);
  });

  it('answers 404, not 500, when TMDB sends no results at all', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ data: {} });

    await request(app).post('/me').set(...authHeader()).expect(404);
    expect(prisma.movieReview.deleteMany).not.toHaveBeenCalled();
  });
});
