const express = require("express");
const router = express.Router();
const prisma = require("../../utils/prisma");
const axios = require("axios");

const { rateLimiter } = require("../../utils/rateLimiter");
// Defaults to 5 requests per 15 minutes per IP
const rateLimit = rateLimiter({
  message: "Too many requests to the TMDB Oauth route, please try again later.",
});

const auth = require("../../middleware/auth");
const { cacheData, getCachedData } = require("../../utils/cache");
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const callbackUrl = process.env.CALLBACK_URL + "/oauth/tmdb/callback";

router.get("/", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      return res.status(400).json({ error: "User not found" });
    }

    // Get a request token from TMDb
    const { data } = await axios.get(
      "https://api.themoviedb.org/3/authentication/token/new",
      { params: { api_key: TMDB_API_KEY } }
    );
    const requestToken = data.request_token;

    const state = await cacheData({
      prefix: "tmdb_oauth",
      data: `${requestToken}&user=${req.user.id}`,
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

router.get("/callback", rateLimit, auth, async (req, res) => {
  try {
    const { request_token } = req.query;
    const userId = req.user.id;
    const state = req.query.state;
    if (!request_token) {
      return res.status(400).json({ error: "Missing request_token" });
    }

    const validToken = await getCachedData({
      key: state,
    });

    // Validate the user and request_token
    if (!validToken) {
      return res.status(400).json({ error: "Invalid request_token" });
    }

    // await

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

    // Save sessionId in your Oauth table for this user
    await prisma.oauth.upsert({
      where: {
        userId_provider: {
          userId,
          provider: "tmdb",
        },
      },
      update: {
        providerUserId: String(tmdbUserId),
        accessToken: sessionId,
      },
      create: {
        provider: "tmdb",
        providerUserId: String(tmdbUserId),
        accessToken: sessionId,
        userId,
      },
    });

    res.json({ session_id: sessionId, tmdb_user_id: tmdbUserId });
  } catch (error) {
    console.error(
      "Error exchanging TMDb token:",
      error?.response?.data || error.message
    );
    res.status(500).json({ error: "Failed to exchange TMDb token" });
  }
});

module.exports = router;
