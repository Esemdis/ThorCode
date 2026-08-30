// The network half of the playlist feature. The decisions — which songs, which
// search string, which of the results — are in utils/setlistPlaylist.js and are
// tested there; this file only talks to Spotify and to the OAuth table.
//
// Two endpoints here are newer than every tutorial you will find: Spotify
// removed POST /users/{id}/playlists and POST /playlists/{id}/tracks for
// Development Mode apps in February 2026, replacing them with POST /me/playlists
// and POST /playlists/{id}/items. The same change capped search results at 10.

const axios = require('axios');
const { retryDelayMs } = require('./spotifyRetry');
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

// An app-level token, for reads that are about an artist rather than about a
// user. Artist search needs no scope, and most users have never connected
// Spotify, so getValidToken is the wrong door entirely.
//
// Held in a module-level memo rather than Redis: it is one token per process,
// and re-fetching it on a cold start is cheaper than a cache round trip.
let appToken = null;

/**
 * A client-credentials token for the app itself.
 *
 * @throws {SpotifyAuthError} When the server has no Spotify credentials.
 */
async function getAppToken() {
  if (appToken && appToken.expiresAt > Date.now()) return appToken.value;

  if (!clientId() || !clientSecret()) {
    throw new SpotifyAuthError('Spotify is not configured on this server');
  }

  const { data } = await axios.post(
    `${ACCOUNTS_URL}/api/token`,
    new URLSearchParams({ grant_type: 'client_credentials' }),
    { headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  appToken = { value: data.access_token, expiresAt: expiryFrom(data.expires_in).getTime() };
  return appToken.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A GET that waits out a brief 429 rather than failing the whole playlist for
 * it, and gives up rather than sleeping through a long one.
 */
async function getWithBackoff(url, config, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await axios.get(url, config);
    } catch (error) {
      const status = error.response?.status;
      if (status === 401) throw new SpotifyAuthError('Spotify rejected the token');
      if (status !== 429 || attempt === attempts) throw error;
      const wait = retryDelayMs(error.response.headers['retry-after']);
      if (wait === null) {
        console.error(`[spotify] Rate limited for ${error.response.headers['retry-after']}s — giving up rather than waiting it out`);
        throw error;
      }
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

/**
 * Artists matching a free-text query, in Spotify's relevance order.
 *
 * Capped at SEARCH_LIMIT like every other search here — dev-mode apps error on
 * a larger limit rather than truncating.
 *
 * @returns {Promise<object[]>} Raw artist objects; the caller decides what of
 *   them to use.
 */
async function searchArtists(query) {
  const token = await getAppToken();
  const { data } = await getWithBackoff(`${API_URL}/search`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { q: query, type: 'artist', limit: SEARCH_LIMIT },
  });
  return data?.artists?.items ?? [];
}

/**
 * Artist objects for a set of ids.
 *
 * One request per id, not the /artists?ids= batch endpoint: that endpoint
 * answers 403 Forbidden for a Development Mode app, the same restriction that
 * costs this app genres and popularity elsewhere. The caller keeps the id list
 * small (see ARTIST_CONCURRENCY in bandImages) so this stays a short burst
 * rather than a few hundred parallel requests.
 *
 * An id that fails individually is dropped rather than failing the set — one
 * artist Spotify will not serve should cost one photo, not all of them.
 *
 * @returns {Promise<object[]>} Raw artist objects, failures and nulls stripped.
 */
async function getArtists(ids) {
  if (!ids?.length) return [];
  const token = await getAppToken();
  const headers = { Authorization: `Bearer ${token}` };

  const results = await Promise.all((ids).map(async (id) => {
    try {
      const { data } = await getWithBackoff(`${API_URL}/artists/${id}`, { headers });
      return data;
    } catch (error) {
      console.error(`[spotify] Artist ${id} lookup failed:`, error.response?.status ?? error.message);
      return null;
    }
  }));
  return results.filter(Boolean);
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
  getAppToken,
  searchArtists,
  getArtists,
  findTrack,
  createPlaylist,
  addItems,
  isConnected,
};
