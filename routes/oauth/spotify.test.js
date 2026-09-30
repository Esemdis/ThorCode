import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

const prisma = installFakePrisma({ oAuth: { upsert: vi.fn(async () => ({})) } });

const { default: router } = await import('./spotify.js');
const app = buildApp(router, '/oauth/spotify');

// The router's own copy of the Spotify client, which it calls through the
// module so these can stand in for the network.
const require = createRequire(import.meta.url);
const spotify = require('../../utils/spotify.js');
const { signOAuthState } = require('../../utils/oauthState.js');

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET ||= 'test-secret';
  process.env.CALLBACK_URL = 'https://api.example.test';
  process.env.CONCERT_MAP_URL = 'https://map.example.test/';
  vi.spyOn(spotify, 'exchangeCode').mockResolvedValue({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 's' });
  vi.spyOn(spotify, 'me').mockResolvedValue({ id: 'spotify-user' });
});

const stateFor = (user) => signOAuthState({ user, purpose: 'spotify_oauth' });

describe('the callback page shown when there is no app to return to', () => {
  it('shows Spotify\'s error as text, never as markup', async () => {
    // `error` is a query parameter anyone can put in a link. Written into this
    // page as-is, it ran as script on the API's origin.
    delete process.env.CONCERT_MAP_URL;

    const res = await request(app).get('/oauth/spotify/callback').query({ error: '<script>alert(1)</script>' });

    expect(res.status).toBe(400);
    expect(res.text).not.toContain('<script>');
    expect(res.text).toContain('&lt;script&gt;');
  });
});

describe('connecting Spotify', () => {
  // The state says who started the flow, but not whose browser finishes it.
  // The callback used to link whatever Spotify account came back to the user
  // in the state, so an authorize link someone minted for themselves and sent
  // on put the recipient's Spotify on the sender's account. The callback now
  // only hands the code back to the app, and the app finishes with its own
  // sign-in — which has to be the user who started.

  it('hands the code back to the app rather than linking anything itself', async () => {
    const state = stateFor('user-1');

    const res = await request(app).get('/oauth/spotify/callback').query({ code: 'the-code', state });

    expect(res.status).toBe(302);
    const back = new URL(res.headers.location);
    expect(back.origin + back.pathname).toBe('https://map.example.test/');
    expect(back.searchParams.get('spotify_code')).toBe('the-code');
    expect(back.searchParams.get('spotify_state')).toBe(state);
    expect(spotify.exchangeCode).not.toHaveBeenCalled();
    expect(prisma.oAuth.upsert).not.toHaveBeenCalled();
  });

  it('still says so at once when the state is no good', async () => {
    const res = await request(app).get('/oauth/spotify/callback').query({ code: 'c', state: 'forged' });

    expect(new URL(res.headers.location).searchParams.get('reason')).toBe('expired_state');
  });

  it('cannot finish without an app to finish it in', async () => {
    delete process.env.CONCERT_MAP_URL;

    const res = await request(app).get('/oauth/spotify/callback').query({ code: 'c', state: stateFor('user-1') });

    expect(res.status).toBe(400);
    expect(prisma.oAuth.upsert).not.toHaveBeenCalled();
  });

  it('links the account for the user who started, signed in as themselves', async () => {
    const res = await request(app)
      .post('/oauth/spotify/complete')
      .set(...authHeader({ id: 'user-1' }))
      .send({ code: 'the-code', state: stateFor('user-1') });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: true, account: 'spotify-user' });
    expect(spotify.exchangeCode).toHaveBeenCalledWith({
      code: 'the-code', redirectUri: 'https://api.example.test/oauth/spotify/callback',
    });
    expect(prisma.oAuth.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { user_provider: { user: 'user-1', provider: 'spotify' } },
    }));
  });

  it('refuses to finish someone else\'s flow', async () => {
    const res = await request(app)
      .post('/oauth/spotify/complete')
      .set(...authHeader({ id: 'victim' }))
      .send({ code: 'the-code', state: stateFor('attacker') });

    expect(res.status).toBe(403);
    expect(spotify.exchangeCode).not.toHaveBeenCalled();
    expect(prisma.oAuth.upsert).not.toHaveBeenCalled();
  });

  it('refuses a state that is not ours, or no code at all', async () => {
    const forged = await request(app).post('/oauth/spotify/complete')
      .set(...authHeader({ id: 'user-1' })).send({ code: 'c', state: 'forged' });
    const noCode = await request(app).post('/oauth/spotify/complete')
      .set(...authHeader({ id: 'user-1' })).send({ state: stateFor('user-1') });

    expect(forged.status).toBe(400);
    expect(noCode.status).toBe(400);
    expect(prisma.oAuth.upsert).not.toHaveBeenCalled();
  });

  it('says when Spotify would not trade the code', async () => {
    spotify.exchangeCode.mockRejectedValue(Object.assign(new Error('bad'), { response: { data: { error: 'invalid_grant' } } }));

    const res = await request(app).post('/oauth/spotify/complete')
      .set(...authHeader({ id: 'user-1' })).send({ code: 'used', state: stateFor('user-1') });

    expect(res.status).toBe(502);
    expect(prisma.oAuth.upsert).not.toHaveBeenCalled();
  });
});
