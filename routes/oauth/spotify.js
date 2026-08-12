// Connecting a user's Spotify account, so their setlist playlists land in it.
//
// Shaped like routes/oauth/tmdb.js with two deliberate differences.
//
// The callback runs without `auth`. It arrives as a top-level browser
// navigation from Spotify, which cannot carry an Authorization header, so the
// only way to know whose account this is is the state value we minted when the
// flow started.
//
// And that state is signed rather than stored, so connecting works on a server
// with no Redis — see utils/oauthState.js. The Redis-backed version failed with
// a 500 whenever the cache was unreachable, which is a state this app otherwise
// tolerates.

const express = require('express');
const router = express.Router();
const prisma = require('../../prisma/client');

const auth = require('../../auth/verifyJWT');
const { rateLimiter } = require('../../utils/rateLimiter');
const { signOAuthState, verifyOAuthState } = require('../../utils/oauthState');
const {
  PROVIDER, authorizeUrl, exchangeCode, expiryFrom, me,
} = require('../../utils/spotify');

const rateLimit = rateLimiter({
  message: 'Too many requests to the Spotify OAuth route, please try again later.',
});

const STATE_PURPOSE = 'spotify_oauth';

const redirectUri = () => `${process.env.CALLBACK_URL}/oauth/spotify/callback`;

/**
 * GET /oauth/spotify/authorize-url
 *
 * Returns the URL as JSON instead of redirecting, because this call needs the
 * user's bearer token and a redirect the browser follows would not carry one.
 * The client navigates to what it gets back.
 */
router.get('/authorize-url', auth, rateLimit, async (req, res) => {
  try {
    if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
      return res.status(503).json({ error: 'Spotify is not configured on this server' });
    }
    const state = signOAuthState({ user: req.user.id, purpose: STATE_PURPOSE });
    res.json({ url: authorizeUrl({ state, redirectUri: redirectUri() }) });
  } catch (error) {
    console.error('Error starting Spotify OAuth:', error.message);
    res.status(500).json({ error: 'Failed to start Spotify OAuth' });
  }
});

/**
 * GET /oauth/spotify/callback
 *
 * Unauthenticated by necessity — see the note at the top of the file.
 */
router.get('/callback', rateLimit, async (req, res) => {
  const { code, state, error: denied } = req.query;

  const done = (params) => {
    // Tolerate a trailing slash on the configured URL — prd has one, and
    // "https://host//?spotify=connected" is a different path to some routers.
    const base = process.env.CONCERT_MAP_URL?.replace(/\/+$/, '');
    if (!base) {
      // No frontend configured to return to: say so in the tab rather than
      // redirecting nowhere.
      const ok = params.spotify === 'connected';
      return res
        .status(ok ? 200 : 400)
        .send(`<p>${ok ? 'Spotify connected. You can close this tab.' : `Spotify connection failed: ${params.reason}`}</p>`);
    }
    return res.redirect(`${base}/?${new URLSearchParams(params)}`);
  };

  try {
    if (denied) return done({ spotify: 'failed', reason: String(denied) });
    if (!code || !state) return done({ spotify: 'failed', reason: 'missing_code' });

    const stored = verifyOAuthState(state, STATE_PURPOSE);
    if (!stored) return done({ spotify: 'failed', reason: 'expired_state' });

    const token = await exchangeCode({ code: String(code), redirectUri: redirectUri() });
    const profile = await me(token.access_token);

    await prisma.oAuth.upsert({
      where: { user_provider: { user: stored.user, provider: PROVIDER } },
      update: {
        provider_user_id: String(profile.id),
        access_token: token.access_token,
        refresh_token: token.refresh_token ?? null,
        expires_at: expiryFrom(token.expires_in),
        scope: token.scope ?? null,
      },
      create: {
        provider: PROVIDER,
        provider_user_id: String(profile.id),
        access_token: token.access_token,
        refresh_token: token.refresh_token ?? null,
        expires_at: expiryFrom(token.expires_in),
        scope: token.scope ?? null,
        user: stored.user,
      },
    });

    return done({ spotify: 'connected' });
  } catch (error) {
    console.error('Error completing Spotify OAuth:', error.response?.data ?? error.message);
    return done({ spotify: 'failed', reason: 'exchange_failed' });
  }
});

/** GET /oauth/spotify/status — whether this user has connected Spotify. */
router.get('/status', auth, async (req, res) => {
  try {
    const row = await prisma.oAuth.findUnique({
      where: { user_provider: { user: req.user.id, provider: PROVIDER } },
      select: { provider_user_id: true },
    });
    res.json({
      connected: !!row,
      account: row?.provider_user_id ?? null,
      configured: !!process.env.SPOTIFY_CLIENT_ID,
    });
  } catch (error) {
    console.error('Error reading Spotify status:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** DELETE /oauth/spotify — disconnect. */
router.delete('/', auth, async (req, res) => {
  try {
    await prisma.oAuth.deleteMany({ where: { user: req.user.id, provider: PROVIDER } });
    res.json({ connected: false });
  } catch (error) {
    console.error('Error disconnecting Spotify:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
