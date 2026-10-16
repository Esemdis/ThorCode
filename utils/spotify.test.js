import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { installFakePrisma } from '../test/routeApp.js';

installFakePrisma({ oAuth: { findUnique: vi.fn(), update: vi.fn() } });

// This file's own copies — it is CommonJS and loads them through Node's
// require, which an ESM import would not share.
const require = createRequire(import.meta.url);
const axios = require('axios');
const spotify = require('./spotify.js');

const ok = (data) => ({ data });
const page = (ids, after, next = !!after) => ok({
  artists: { items: ids.map((id) => ({ id, name: id })), cursors: { after }, next: next ? 'https://api.spotify.com/v1/me/following?…' : null },
});

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.SPOTIFY_CLIENT_ID = 'client-id';
  process.env.SPOTIFY_CLIENT_SECRET = 'client-secret';
});

describe('connecting', () => {
  it('asks for top and followed artists as well as the playlist scope', () => {
    // A connection without these answers the listening reads with a 403, and
    // only a fresh consent screen can add a scope.
    const url = new URL(spotify.authorizeUrl({ state: 's', redirectUri: 'https://api/cb' }));
    expect(url.searchParams.get('scope').split(' ')).toEqual(['playlist-modify-private', 'user-top-read', 'user-follow-read']);
  });
});

describe('followedArtists', () => {
  it('follows the after-cursor from page to page until there is no next', async () => {
    const request = vi.spyOn(axios, 'request')
      .mockResolvedValueOnce(page(['a', 'b'], 'b'))
      .mockResolvedValueOnce(page(['c'], 'c', false));

    const out = await spotify.followedArtists('token');

    expect(out.map((a) => a.id)).toEqual(['a', 'b', 'c']);
    expect(request.mock.calls.map(([c]) => c.params)).toEqual([
      { type: 'artist', limit: 50 },
      { type: 'artist', limit: 50, after: 'b' },
    ]);
    expect(request.mock.calls[0][0].url).toBe('https://api.spotify.com/v1/me/following');
  });

  it('stops after four pages however many someone follows', async () => {
    const request = vi.spyOn(axios, 'request').mockImplementation(async () => page(['x'], 'x'));

    await spotify.followedArtists('token');

    expect(request).toHaveBeenCalledTimes(4);
  });

  it('turns a 401 into SpotifyAuthError, so the route asks for a reconnect', async () => {
    vi.spyOn(axios, 'request').mockRejectedValue(Object.assign(new Error('401'), { response: { status: 401 } }));

    await expect(spotify.followedArtists('token')).rejects.toBeInstanceOf(spotify.SpotifyAuthError);
  });
});
