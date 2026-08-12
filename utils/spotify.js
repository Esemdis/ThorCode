// The network half of the playlist feature. The decisions — which songs, which
// search string, which of the results — are in utils/setlistPlaylist.js and are
// tested there; this file only talks to Spotify and to the OAuth table.
//
// Two endpoints here are newer than every tutorial you will find: Spotify
// removed POST /users/{id}/playlists and POST /playlists/{id}/tracks for
// Development Mode apps in February 2026, replacing them with POST /me/playlists
// and POST /playlists/{id}/items. The same change capped search results at 10.

const axios = require('axios');
const prisma = require('./../prisma/client');
const { searchQueries, pickBestTrack } = require('./setlistPlaylist');

const ACCOUNTS_URL = 'https://accounts.spotify.com';
const API_URL = 'https://api.spotify.com/v1';
const PROVIDER = 'spotify';

// Creating a private playlist and putting songs in it. Nothing here reads the
// user's library or listening history, so nothing else is asked for.
const SCOPES = ['playlist-modify-private'];

// Dev-mode apps are capped at 10 results per search; asking for more is an error
// rather than a truncation.
const SEARCH_LIMIT = 10;

// The API takes at most 100 items per add call.
const ADD_CHUNK = 100;

// Refresh a minute early. A token that expires between our check and Spotify's
// costs a whole request to discover.
const EXPIRY_MARGIN_MS = 60 * 1000;

/**
 * Raised when the problem is the user's connection rather than the request:
 * they have not linked Spotify, or the refresh token no longer works. The route
 * turns this into "reconnect", never a 500.
 */
class SpotifyAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpotifyAuthError';
  }
}

const clientId = () => process.env.SPOTIFY_CLIENT_ID;
const clientSecret = () => process.env.SPOTIFY_CLIENT_SECRET;

function basicAuthHeader() {
  const encoded = Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64');
  return `Basic ${encoded}`;
}

/** Where to send the browser to start the connect flow. */
function authorizeUrl({ state, redirectUri }) {
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    state,
    // Always show the consent screen: reconnecting after a revoked token is a
    // deliberate act, and silently reusing the old grant hides that it failed.
    show_dialog: 'true',
  });
  return `${ACCOUNTS_URL}/authorize?${params}`;
}

function expiryFrom(expiresInSeconds) {
  const seconds = Number(expiresInSeconds) || 3600;
  return new Date(Date.now() + seconds * 1000 - EXPIRY_MARGIN_MS);
}

/** Trade the code from the callback for a token pair. */
async function exchangeCode({ code, redirectUri }) {
  const { data } = await axios.post(
    `${ACCOUNTS_URL}/api/token`,
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    { headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return data;
}

/** Who the token belongs to. Used for provider_user_id on the OAuth row. */
async function me(accessToken) {
  const { data } = await axios.get(`${API_URL}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return data;
}

/**
 * A usable access token for this user, refreshing it first if it has expired.
 *
 * @throws {SpotifyAuthError} When there is no connection, or the refresh fails.
 */
async function getValidToken(userId) {
  const row = await prisma.oAuth.findUnique({
    where: { user_provider: { user: userId, provider: PROVIDER } },
  });
  if (!row) throw new SpotifyAuthError('Spotify is not connected');

  const stillValid = row.expires_at && row.expires_at.getTime() > Date.now();
  if (stillValid) return row.access_token;

  if (!row.refresh_token) {
    throw new SpotifyAuthError('Spotify connection has expired and cannot be refreshed');
  }

  let data;
  try {
    ({ data } = await axios.post(
      `${ACCOUNTS_URL}/api/token`,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token }),
      { headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' } },
    ));
  } catch (error) {
    // A refresh token stops working when the user revokes access in their
    // Spotify account. That is not an outage — they have to connect again.
    console.error('[spotify] Refresh failed:', error.response?.data ?? error.message);
    throw new SpotifyAuthError('Spotify connection is no longer valid');
  }

  await prisma.oAuth.update({
    where: { user_provider: { user: userId, provider: PROVIDER } },
    data: {
      access_token: data.access_token,
      // Spotify usually keeps the same refresh token, but is allowed to issue a
      // new one; dropping it would break the next refresh.
      ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
      expires_at: expiryFrom(data.expires_in),
      ...(data.scope ? { scope: data.scope } : {}),
    },
  });

  return data.access_token;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A GET that waits out a 429 rather than failing the whole playlist for it.
 * Spotify's Retry-After is in seconds. Bounded, so a sustained limit gives up
 * instead of hanging the request.
 */
async function getWithBackoff(url, config, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await axios.get(url, config);
    } catch (error) {
      const status = error.response?.status;
      if (status === 401) throw new SpotifyAuthError('Spotify rejected the token');
      if (status !== 429 || attempt === attempts) throw error;
      const wait = (Number(error.response.headers['retry-after']) || 2) * 1000;
      console.warn(`[spotify] Rate limited, waiting ${wait}ms (attempt ${attempt}/${attempts})`);
      await sleep(wait);
    }
  }
  throw new Error('unreachable');
}

/**
 * Find one track. Tries the precise query first and the loose one only if the
 * precise one found nothing at all.
 *
 * @returns {{ uri: string, name: string, artist: string }|null}
 */
async function findTrack(accessToken, track) {
  const headers = { Authorization: `Bearer ${accessToken}` };

  for (const q of searchQueries(track)) {
    const { data } = await getWithBackoff(`${API_URL}/search`, {
      headers,
      params: { q, type: 'track', limit: SEARCH_LIMIT },
    });
    const best = pickBestTrack(data?.tracks?.items, track);
    if (best) {
      return { uri: best.uri, name: best.name, artist: best.artists?.[0]?.name ?? '' };
    }
  }
  return null;
}

/** Create an empty private playlist on the connected account. */
async function createPlaylist(accessToken, { name, description }) {
  const { data } = await axios.post(
    `${API_URL}/me/playlists`,
    // Spotify caps the description; a long festival lineup would be rejected.
    { name, description: String(description ?? '').slice(0, 300), public: false },
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return { id: data.id, url: data.external_urls?.spotify ?? null };
}

/** Add track URIs to a playlist, in the order given. */
async function addItems(accessToken, playlistId, uris) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  for (let i = 0; i < uris.length; i += ADD_CHUNK) {
    await axios.post(
      `${API_URL}/playlists/${playlistId}/items`,
      { uris: uris.slice(i, i + ADD_CHUNK) },
      { headers },
    );
  }
}

/** Whether this user has connected Spotify. */
async function isConnected(userId) {
  const row = await prisma.oAuth.findUnique({
    where: { user_provider: { user: userId, provider: PROVIDER } },
    select: { id: true },
  });
  return !!row;
}

module.exports = {
  PROVIDER,
  SCOPES,
  SpotifyAuthError,
  authorizeUrl,
  exchangeCode,
  expiryFrom,
  me,
  getValidToken,
  findTrack,
  createPlaylist,
  addItems,
  isConnected,
};
