// Which service a playlist is built on, once more than one can be connected.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

const prisma = installFakePrisma({
  concert: { findUnique: vi.fn() },
  oAuth: { findUnique: vi.fn(async () => null), findMany: vi.fn() },
  user: { findUnique: vi.fn() },
});

const { default: router } = await import('./playlists.js');
const app = buildApp(router, '/data/concerts');

// The router's own copy, which it calls through the module.
const require = createRequire(import.meta.url);
const externalSetlists = require('../../utils/externalSetlists.js');
const spotify = require('../../utils/spotify.js');
const tidal = require('../../utils/tidal.js');

// Five playlists a minute per caller, and every request here comes from one
// address: the file as a whole has to stay inside that. Which is why these are
// not in playlists.test.js, which is already at five.
const user = authHeader({ id: 'user-1' });

// The services this user has connected, and what they chose in Settings.
const accounts = (providers, settings = null) => {
  prisma.oAuth.findMany.mockResolvedValue(providers.map((provider) => ({ provider })));
  prisma.user.findUnique.mockResolvedValue({ settings });
};

// Both services answering every search with a track named after the song.
const answering = (client, prefix, url) => {
  vi.spyOn(client, 'getValidToken').mockResolvedValue('token');
  vi.spyOn(client, 'findTrack').mockImplementation(async (token, track) => ({ uri: `${prefix}${track.title}` }));
  vi.spyOn(client, 'createPlaylist').mockResolvedValue({ id: 'p1', url });
  vi.spyOn(client, 'addItems').mockResolvedValue();
};
const connected = () => {
  accounts(['spotify']);
  answering(spotify, 'spotify:track:', 'https://open.spotify.com/playlist/p1');
  answering(tidal, '', 'https://tidal.com/playlist/p1');
};
const songs = (...names) => ({ songs: names.map((name) => ({ name, tape: false, cover: null })) });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  accounts([]);
  prisma.concert.findMany = vi.fn(async () => []);
  prisma.concert.findUnique.mockResolvedValue({
    id: 3, name: 'Copenhell', venue: 'Refshaleøen', city: 'Copenhagen', concert_date: new Date('2026-06-18'),
    // Two acts nobody follows: their songs would be fetched from setlist.fm.
    metadata: '["Korn","Slipknot"]',
    bands: [],
  });
  vi.spyOn(externalSetlists, 'fetchSetlistsForNames').mockResolvedValue(new Map());
});

describe('which service a playlist goes to', () => {
  it('builds on Tidal when that is the one you chose, and leaves Spotify alone', async () => {
    connected();
    accounts(['spotify', 'tidal'], { playlistService: 'tidal' });
    externalSetlists.fetchSetlistsForNames.mockResolvedValue(new Map([['korn', songs('Blind', 'Freak on a Leash')]]));

    const res = await request(app).post('/data/concerts/3/playlist').set(...user);

    expect(res.status).toBe(201);
    expect(res.body.service).toBe('tidal');
    expect(res.body.url).toBe('https://tidal.com/playlist/p1');
    expect(tidal.addItems).toHaveBeenCalledWith('token', 'p1', ['Blind', 'Freak on a Leash']);
    expect(spotify.getValidToken).not.toHaveBeenCalled();
    expect(spotify.createPlaylist).not.toHaveBeenCalled();
  });

  it('uses the service you have when the one you chose is not connected any more', async () => {
    // Choosing Tidal and then disconnecting it should not leave the button
    // asking you to connect while Spotify sits there connected.
    connected();
    accounts(['spotify'], { playlistService: 'tidal' });
    externalSetlists.fetchSetlistsForNames.mockResolvedValue(new Map([['korn', songs('Blind')]]));

    const res = await request(app).post('/data/concerts/3/playlist').set(...user);

    expect(res.status).toBe(201);
    expect(res.body.service).toBe('spotify');
    expect(tidal.getValidToken).not.toHaveBeenCalled();
  });

  it('names the service to reconnect when its grant has gone', async () => {
    connected();
    accounts(['tidal']);
    tidal.getValidToken.mockRejectedValue(new tidal.TidalAuthError('Tidal connection is no longer valid'));

    const res = await request(app).post('/data/concerts/3/playlist').set(...user);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ reconnect: true, services: ['tidal'] });
    expect(externalSetlists.fetchSetlistsForNames).not.toHaveBeenCalled();
  });

  it('says which service found none of the songs', async () => {
    connected();
    accounts(['tidal']);
    tidal.findTrack.mockResolvedValue(null);
    externalSetlists.fetchSetlistsForNames.mockResolvedValue(new Map([['korn', songs('Blind')]]));

    const res = await request(app).post('/data/concerts/3/playlist').set(...user);

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/found on Tidal/);
    expect(tidal.createPlaylist).not.toHaveBeenCalled();
  });
});
