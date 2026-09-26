import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp, installFakePrisma } from '../../test/routeApp.js';

installFakePrisma({ oAuth: {} });

const { default: router } = await import('./spotify.js');
const app = buildApp(router, '/oauth/spotify');

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
