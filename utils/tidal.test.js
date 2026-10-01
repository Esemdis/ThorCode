import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { installFakePrisma } from '../test/routeApp.js';

const prisma = installFakePrisma({ oAuth: { findUnique: vi.fn(), update: vi.fn() } });

// This file's own copies — it is CommonJS and loads them through Node's
// require, which an ESM import would not share.
const require = createRequire(import.meta.url);
const axios = require('axios');
const tidal = require('./tidal.js');
const { signOAuthState, pkceVerifier, pkceChallenge } = require('./oauthState.js');

const ok = (data) => ({ data });
const tooMany = () => Object.assign(new Error('429'), { response: { status: 429, headers: {} } });

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.JWT_SECRET ||= 'test-secret';
  process.env.TIDAL_CLIENT_ID = 'client-id';
  process.env.TIDAL_CLIENT_SECRET = 'client-secret';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connecting', () => {
  it('sends the challenge for the verifier the exchange will send', async () => {
    // Worked out from the state at both ends rather than stored — see
    // pkceVerifier. If the two ever disagree, every connection fails at the
    // last step with an invalid_grant.
    const state = signOAuthState({ user: 'user-1', purpose: 'tidal_oauth' });
    const post = vi.spyOn(axios, 'post').mockResolvedValue(ok({ access_token: 'at', user_id: 42 }));

    const url = new URL(tidal.authorizeUrl({ state, redirectUri: 'https://api.example.test/oauth/tidal/callback' }));
    await tidal.exchangeCode({ code: 'the-code', redirectUri: 'https://api.example.test/oauth/tidal/callback', state });

    const sent = new URLSearchParams(post.mock.calls[0][1]);
    expect(url.origin).toBe('https://login.tidal.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(pkceChallenge(sent.get('code_verifier')));
    expect(sent.get('code_verifier')).toBe(pkceVerifier(state));
    expect(url.searchParams.get('scope')).toBe('playlists.write search.read');
  });

  it('keeps the refresh token it has when a refresh does not issue a new one', async () => {
    prisma.oAuth.findUnique.mockResolvedValue({ access_token: 'old', refresh_token: 'rt', expires_at: new Date(0) });
    vi.spyOn(axios, 'post').mockResolvedValue(ok({ access_token: 'new', expires_in: 3600 }));

    expect(await tidal.getValidToken('user-1')).toBe('new');
    expect(prisma.oAuth.update.mock.calls[0][0].data).not.toHaveProperty('refresh_token');
  });

  it('asks you to reconnect, rather than failing, when the refresh is refused', async () => {
    prisma.oAuth.findUnique.mockResolvedValue({ access_token: 'old', refresh_token: 'rt', expires_at: new Date(0) });
    vi.spyOn(axios, 'post').mockRejectedValue(Object.assign(new Error('400'), { response: { data: { error: 'invalid_grant' } } }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(tidal.getValidToken('user-1')).rejects.toBeInstanceOf(tidal.TidalAuthError);
  });
});

describe('findTrack', () => {
  const search = (...tracks) => ok({
    data: [{ id: 'q', type: 'searchResults', relationships: { tracks: { data: tracks.map(({ id }) => ({ id, type: 'tracks' })) } } }],
    included: tracks.map(({ id, title, version = null }) => ({ id, type: 'tracks', attributes: { title, version } })),
  });

  it('is one search when only one result has the song\'s name', async () => {
    const request = vi.spyOn(axios, 'request').mockResolvedValue(search({ id: '7', title: 'Blind' }, { id: '8', title: 'Freak on a Leash' }));

    const found = await tidal.findTrack('token', { title: 'Blind', artist: 'Korn' });

    expect(found).toEqual({ uri: '7', name: 'Blind' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0].params).toEqual({ 'filter[query]': 'Blind Korn', include: 'tracks' });
  });

  it('asks who recorded the tied results, and takes the right artist\'s', async () => {
    const artists = (name) => ok({ data: [{ id: 'a', type: 'artists' }], included: [{ id: 'a', type: 'artists', attributes: { name } }] });
    const request = vi.spyOn(axios, 'request')
      .mockResolvedValueOnce(search({ id: 'cover', title: 'Blind' }, { id: 'real', title: 'Blind' }))
      .mockResolvedValueOnce(artists('Rockabye Baby!'))
      .mockResolvedValueOnce(artists('Korn'));

    const found = await tidal.findTrack('token', { title: 'Blind', artist: 'Korn' });

    expect(found.uri).toBe('real');
    expect(request.mock.calls[2][0].url).toMatch(/\/tracks\/real\/relationships\/artists$/);
  });

  it('settles on the name alone when Tidal will not say who recorded them', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(axios, 'request')
      .mockResolvedValueOnce(search({ id: 'first', title: 'Blind' }, { id: 'second', title: 'Blind' }))
      .mockRejectedValue(Object.assign(new Error('403'), { response: { status: 403 } }));

    expect((await tidal.findTrack('token', { title: 'Blind', artist: 'Korn' })).uri).toBe('first');
  });

  it('turns a refused token into a reconnect', async () => {
    vi.spyOn(axios, 'request').mockRejectedValue(Object.assign(new Error('401'), { response: { status: 401 } }));

    await expect(tidal.findTrack('token', { title: 'Blind', artist: 'Korn' })).rejects.toBeInstanceOf(tidal.TidalAuthError);
  });
});

describe('writing the playlist', () => {
  it('creates an unlisted playlist, since Tidal has no private ones', async () => {
    const request = vi.spyOn(axios, 'request').mockResolvedValue(ok({
      data: { id: 'pl-1', type: 'playlists', attributes: { externalLinks: [{ href: 'https://tidal.com/browse/playlist/pl-1', meta: { type: 'TIDAL_SHARING' } }] } },
    }));

    const playlist = await tidal.createPlaylist('token', { name: 'Korn — 1 Jan 2026', description: 'x'.repeat(600) });

    const { data, headers } = request.mock.calls[0][0];
    expect(playlist).toEqual({ id: 'pl-1', url: 'https://tidal.com/browse/playlist/pl-1' });
    expect(data.data).toMatchObject({ type: 'playlists', attributes: { name: 'Korn — 1 Jan 2026', accessType: 'UNLISTED' } });
    expect(data.data.attributes.description).toHaveLength(500);
    expect(headers['Content-Type']).toBe('application/vnd.api+json');
  });

  it('retries a rate-limited create with the same key, so it cannot make two', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = vi.spyOn(axios, 'request')
      .mockRejectedValueOnce(tooMany())
      .mockResolvedValueOnce(ok({ data: { id: 'pl-1', type: 'playlists', attributes: {} } }));

    const created = tidal.createPlaylist('token', { name: 'n', description: 'd' });
    await vi.advanceTimersByTimeAsync(2000);
    await created;

    const [first, second] = request.mock.calls.map(([config]) => config.headers['Idempotency-Key']);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it('adds tracks fifty at a time, in order, each batch under its own key', async () => {
    const request = vi.spyOn(axios, 'request').mockResolvedValue(ok({}));
    const ids = Array.from({ length: 120 }, (_, i) => String(i));

    await tidal.addItems('token', 'pl-1', ids);

    const batches = request.mock.calls.map(([config]) => config.data.data.map((item) => item.id));
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(batches.flat()).toEqual(ids);
    expect(request.mock.calls[0][0].data.data[0]).toEqual({ type: 'tracks', id: '0' });
    const keys = new Set(request.mock.calls.map(([config]) => config.headers['Idempotency-Key']));
    expect(keys.size).toBe(3);
  });
});
