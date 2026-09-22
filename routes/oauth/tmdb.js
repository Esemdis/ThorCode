const express = require("express");
const router = express.Router();
const prisma = require("../../prisma/client");
const axios = require("axios");

const { rateLimiter } = require("../../utils/rateLimiter");
// Defaults to 5 requests per 15 minutes per IP
const rateLimit = rateLimiter({
  message: "Too many requests to the TMDB Oauth route, please try again later.",
});

const auth = require("../../auth/verifyJWT");
const { signOAuthState, verifyOAuthState } = require('../../utils/oauthState');
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const callbackUrl = process.env.CALLBACK_URL + "/oauth/tmdb/callback";

const STATE_PURPOSE = 'tmdb_oauth';

function done(res, params) {
  const base = process.env.CONCERT_MAP_URL?.replace(/\/+$/, '');
  if (!base) {
    const ok = params.tmdb === 'connected';
    return res
      .status(ok ? 200 : 400)
      .send(`<p>${ok ? 'TMDB connected. You can close this tab.' : `TMDB connection failed: ${params.reason}`}</p>`);
  }
  return res.redirect(`${base}/?${new URLSearchParams(params)}`);
}

router.get("/", auth, rateLimit, async (req, res) => {
  try {
    const userId = req.user.id;
    // Prisma: fetch user by id
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      return res.status(400).json({ error: "User not found" });
    }

    // Get a request token from TMDb
    const { data } = await axios.get(
      "https://api.themoviedb.org/3/authentication/token/new",
      { params: { api_key: TMDB_API_KEY } }
    );
    const requestToken = data.request_token;

    // The browser returns from TMDB without our Authorization header. State
    // therefore carries a short-lived, signed binding between this account and
    // the exact request token that TMDB must return.
    const state = signOAuthState({
      user: req.user.id,
      purpose: STATE_PURPOSE,
      requestToken,
    });
    // Redirect user to TMDb for authentication
    const redirectUrl = `https://www.themoviedb.org/authenticate/${requestToken}?redirect_to=${encodeURIComponent(
      callbackUrl + `?state=${state}`
    )}`;
    res.redirect(redirectUrl);
  } catch (error) {
    console.error(
      "Error starting TMDb OAuth:",
      error?.response?.data || error.message
    );
    res.status(500).json({ error: "Failed to start TMDb OAuth" });
  }
});

router.get("/callback", rateLimit, async (req, res) => {
  try {
    const { request_token } = req.query;
    const state = req.query.state;
    if (!request_token) {
      return done(res, { tmdb: 'failed', reason: 'missing_request_token' });
    }

    const stored = verifyOAuthState(state, STATE_PURPOSE);
    if (!stored || stored.requestToken !== request_token) {
      return done(res, { tmdb: 'failed', reason: 'invalid_state' });
    }
    const userId = stored.user;

    // Exchange request_token for session_id
    const { data } = await axios.post(
      `https://api.themoviedb.org/3/authentication/session/new?api_key=${TMDB_API_KEY}`,
      { request_token }
    );
    const sessionId = data.session_id;

    // Fetch the user's TMDb account ID
    const accountRes = await axios.get(`https://api.themoviedb.org/3/account`, {
      params: {
        api_key: TMDB_API_KEY,
        session_id: sessionId,
      },
    });
    const tmdbUserId = accountRes.data.id;

    try {
      await prisma.oAuth.upsert({
        where: {
          user_provider: {
            user: userId,
            provider: "tmdb",
          },
        },
        update: {
          provider_user_id: String(tmdbUserId),
          access_token: sessionId,
        },
        create: {
          provider: "tmdb",
          provider_user_id: String(tmdbUserId),
          access_token: sessionId,
          user: userId,
        },
      });
    } catch (error) {
      console.error("Error upserting TMDb OAuth data:", error);
      return res
        .status(500)
        .json({ error: "Failed to upsert TMDb OAuth data" });
    }
    // Session ids are credentials. Keep them server-side in OAuth and return
    // the browser to the app with only the connection outcome.
    return done(res, { tmdb: 'connected' });
  } catch (error) {
    console.error(
      "Error exchanging TMDb token:",
      error?.response?.data || error.message
    );
    return done(res, { tmdb: 'failed', reason: 'exchange_failed' });
  }
});

module.exports = router;
