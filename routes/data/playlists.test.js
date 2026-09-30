import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

const prisma = installFakePrisma({
  concert: { findUnique: vi.fn() },
  oAuth: { findUnique: vi.fn(async () => null) },
});

const { default: router } = await import('./playlists.js');
const app = buildApp(router, '/data/concerts');

// The router's own copy, which it calls through the module.
const require = createRequire(import.meta.url);
const externalSetlists = require('../../utils/externalSetlists.js');

beforeEach(() => {
  vi.clearAllMocks();
  prisma.concert.findUnique.mockResolvedValue({
    id: 3, name: 'Copenhell', venue: 'Refshaleøen', city: 'Copenhagen', concert_date: new Date('2026-06-18'),
    // Two acts nobody follows: their songs would be fetched from setlist.fm.
    metadata: '["Korn","Slipknot"]',
    bands: [],
  });
  vi.spyOn(externalSetlists, 'fetchSetlistsForNames').mockResolvedValue(new Map());
});

describe('POST /data/concerts/:concertId/playlist', () => {
  it('asks you to connect Spotify before spending setlist.fm on a bill', async () => {
    // The setlists were fetched first, one setlist.fm search per act on the
    // shared key, and only then did the route find there was nowhere to put
    // the playlist.
    const res = await request(app).post('/data/concerts/3/playlist').set(...authHeader({ id: 'user-1' }));

    expect(res.status).toBe(409);
    expect(res.body.reconnect).toBe(true);
    expect(externalSetlists.fetchSetlistsForNames).not.toHaveBeenCalled();
  });
});
