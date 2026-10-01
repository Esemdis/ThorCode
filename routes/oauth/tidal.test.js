import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

const prisma = installFakePrisma({ oAuth: { upsert: vi.fn(async () => ({})), findUnique: vi.fn() } });

const { default: router } = await import('./tidal.js');
const app = buildApp(router, '/oauth/tidal');

// The router's own copy of the Tidal client, which it calls through the module.
const require = createRequire(import.meta.url);
const tidal = require('../../utils/tidal.js');
const { signOAuthState } = require('../../utils/oauthState.js');

// The Spotify route's tests cover what the two share — the state check, the
// account that finishes having to be the one that started. These are what is
// Tidal's own.

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET ||= 'test-secret';
  process.env.CALLBACK_URL = 'https://api.example.test';
  process.env.CONCERT_MAP_URL = 'https://map.example.test/';
  process.env.TIDAL_CLIENT_ID = 'client-id';
  process.env.TIDAL_CLIENT_SECRET = 'client-secret';
  vi.spyOn(tidal, 'exchangeCode').mockResolvedValue({
    access_token: 'at', refresh_token: 'rt', expires_in: 86400, scope: 'playlists.write search.read', user_id: 192837,
  });
});

const stateFor = (user) => signOAuthState({ user, purpose: 'tidal_oauth' });

describe('connecting Tidal', () => {
  it('sends the browser to Tidal with a PKCE challenge', async () => {
    const res = await request(app).get('/oauth/tidal/authorize-url').set(...authHeader({ id: 'user-1' }));

    const url = new URL(res.body.url);
    expect(url.origin + url.pathname).toBe('https://login.tidal.com/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.example.test/oauth/tidal/callback');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('says so when this server has no Tidal app', async () => {
    delete process.env.TIDAL_CLIENT_SECRET;

    const res = await request(app).get('/oauth/tidal/authorize-url').set(...authHeader({ id: 'user-1' }));

    expect(res.status).toBe(503);
  });

  it('hands the code back to the app under Tidal\'s own names', async () => {
    const state = stateFor('user-1');

    const res = await request(app).get('/oauth/tidal/callback').query({ code: 'the-code', state });

    const back = new URL(res.headers.location);
    expect(back.searchParams.get('tidal_code')).toBe('the-code');
    expect(back.searchParams.get('tidal_state')).toBe(state);
  });

  it('will not finish a flow started for Spotify', async () => {
    // Each service's state names its own flow; one minted for the other must
    // not complete this one.
    const spotifyState = signOAuthState({ user: 'user-1', purpose: 'spotify_oauth' });

    const res = await request(app).post('/oauth/tidal/complete')
      .set(...authHeader({ id: 'user-1' })).send({ code: 'c', state: spotifyState });

    expect(res.status).toBe(400);
    expect(tidal.exchangeCode).not.toHaveBeenCalled();
  });

  it('records the account the token response names, with no profile call', async () => {
    const state = stateFor('user-1');

    const res = await request(app).post('/oauth/tidal/complete')
      .set(...authHeader({ id: 'user-1' })).send({ code: 'the-code', state });

    expect(res.body).toEqual({ connected: true, account: '192837' });
    // The state goes with the code: it is what the PKCE verifier comes from.
    expect(tidal.exchangeCode).toHaveBeenCalledWith(expect.objectContaining({ code: 'the-code', state }));
    expect(prisma.oAuth.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { user_provider: { user: 'user-1', provider: 'tidal' } },
    }));
  });
});
