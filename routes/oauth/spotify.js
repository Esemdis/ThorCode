// Connecting a user's Spotify account, so their setlist playlists land in it.
//
// Shaped like routes/oauth/tmdb.js with two deliberate differences.
//
// The callback runs without `auth`. It arrives as a top-level browser
// navigation from Spotify, which cannot carry an Authorization header. So it
// links nothing: it hands the code back to the app, and the app finishes the
// connection at POST /complete with its own sign-in. The state says who
// started the flow, but not whose browser finishes it — linking at the
// callback put the Spotify account of whoever followed an authorize link on
// the account of whoever minted it.
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
// Through the module rather than destructured, so a test can stand in for
// Spotify on the router's own copy of it.
const spotify = require('../../utils/spotify');

const { PROVIDER } = spotify;
const { escapeHtml } = require('../../utils/html');

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
    res.json({ url: spotify.authorizeUrl({ state, redirectUri: redirectUri() }) });
  } catch (error) {
    console.error('Error starting Spotify OAuth:', error.message);
    res.status(500).json({ error: 'Failed to start Spotify OAuth' });
  }
});

/**
 * GET /oauth/spotify/callback
 *
 * Unauthenticated by necessity — see the note at the top of the file. Checks
 * the state so a stale or forged one fails here, where the user is looking,
 * and hands the code to the app, which finishes at POST /complete.
 */
router.get('/callback', rateLimit, async (req, res) => {
  const { code, state, error: denied } = req.query;
  // Tolerate a trailing slash on the configured URL — prd has one, and
  // "https://host//?spotify=connected" is a different path to some routers.
  const base = process.env.CONCERT_MAP_URL?.replace(/\/+$/, '');

  const failed = (reason) => {
    if (!base) {
      // No frontend configured to return to: say so in the tab rather than
      // redirecting nowhere. `reason` can be Spotify's `?error=`, which is
      // whatever the link says — written into this page unescaped, it ran as
      // script on the API's origin.
      return res.status(400).send(`<p>Spotify connection failed: ${escapeHtml(reason)}</p>`);
    }
    return res.redirect(`${base}/?${new URLSearchParams({ spotify: 'failed', reason })}`);
  };

  if (denied) return failed(String(denied).slice(0, 100));
  if (!code || !state) return failed('missing_code');
  if (!verifyOAuthState(state, STATE_PURPOSE)) return failed('expired_state');
  // Only the app can finish, signed in as whoever started.
  if (!base) return failed('no_app_configured');

  return res.redirect(`${base}/?${new URLSearchParams({ spotify_code: String(code), spotify_state: String(state) })}`);
});

/**
 * POST /oauth/spotify/complete { code, state }
 *
 * Finishes what the callback handed back. The state must name the caller: a
 * flow started by one account cannot be finished by another, so an authorize
 * link sent to someone else links nothing.
 */
router.post('/complete', auth, rateLimit, async (req, res) => {
  const { code, state } = req.body ?? {};
  if (typeof code !== 'string' || !code) return res.status(400).json({ error: 'No code from Spotify' });

  const stored = verifyOAuthState(state, STATE_PURPOSE);
  if (!stored) return res.status(400).json({ error: 'That Spotify connection has expired. Try connecting again.' });
  if (stored.user !== req.user.id) {
    return res.status(403).json({ error: 'That Spotify connection was started by another account.' });
  }

  let token;
  let profile;
  try {
    token = await spotify.exchangeCode({ code, redirectUri: redirectUri() });
    profile = await spotify.me(token.access_token);
  } catch (error) {
    console.error('Error completing Spotify OAuth:', error.response?.data ?? error.message);
    return res.status(502).json({ error: 'Spotify would not complete the connection. Try connecting again.' });
  }

  try {
    const fields = {
      provider_user_id: String(profile.id),
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      expires_at: spotify.expiryFrom(token.expires_in),
      scope: token.scope ?? null,
    };
    await prisma.oAuth.upsert({
      where: { user_provider: { user: req.user.id, provider: PROVIDER } },
      update: fields,
      create: { ...fields, provider: PROVIDER, user: req.user.id },
    });
    return res.json({ connected: true, account: String(profile.id) });
  } catch (error) {
    console.error('Error saving Spotify connection:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
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
