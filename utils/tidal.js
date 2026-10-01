// The network half of building a playlist on Tidal, alongside utils/spotify.js
// and shaped like it: the route calls the same five functions on either.
// Reading Tidal's answers is in utils/tidalTracks.js and is tested there.
//
// Tidal's API is JSON:API and still marked beta. Playlist writes were promised
// from 2023 and are in the reference now, so most of what you will find about
// them elsewhere predates them. The reference is the OpenAPI document at
// https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json — the
// developer site renders it in a browser and shows a fetcher nothing.
//
// Three things differ from Spotify enough to trip over:
//   - Connecting uses PKCE. The verifier comes from the signed state (see
//     pkceVerifier in utils/oauthState.js), so there is still nothing to store.
//   - There are no private playlists. UNLISTED is the nearest: it is not on
//     your profile or in search, but anyone with the link can open it.
//   - A playlist takes 50 tracks per add, not 100.

const crypto = require('node:crypto');
const axios = require('axios');
const prisma = require('./../prisma/client');
const { requestWithBackoff } = require('./retryAfter');
const { pkceVerifier, pkceChallenge } = require('./oauthState');
const {
  searchQuery, searchedTracks, includedNames, playlistUrl, chooseTrack,
} = require('./tidalTracks');

const LOGIN_URL = 'https://login.tidal.com';
const TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token';
const API_URL = 'https://openapi.tidal.com/v2';
const PROVIDER = 'tidal';
const LABEL = 'Tidal';
const JSON_API = 'application/vnd.api+json';

// Creating a playlist, and searching as the user so results are the ones
// their country can play. Nothing reads their library or history.
const SCOPES = ['playlists.write', 'search.read'];

// The API takes at most 50 items per add call.
const ADD_CHUNK = 50;

// The API's own limits on a playlist's name and description.
const NAME_MAX = 250;
const DESCRIPTION_MAX = 500;

// Refresh a minute early, as for Spotify.
const EXPIRY_MARGIN_MS = 60 * 1000;

/**
 * Raised when the problem is the user's connection rather than the request.
 * The route turns this into "reconnect", never a 500.
 */
class TidalAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TidalAuthError';
  }
}

const clientId = () => process.env.TIDAL_CLIENT_ID;
const clientSecret = () => process.env.TIDAL_CLIENT_SECRET;

/** Whether this server can offer Tidal at all. */
function isConfigured() {
  return !!(clientId() && clientSecret());
}

/** Where to send the browser to start the connect flow. */
function authorizeUrl({ state, redirectUri }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId(),
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    code_challenge_method: 'S256',
    code_challenge: pkceChallenge(pkceVerifier(state)),
    state,
  });
  return `${LOGIN_URL}/authorize?${params}`;
}

function expiryFrom(expiresInSeconds) {
  const seconds = Number(expiresInSeconds) || 3600;
  return new Date(Date.now() + seconds * 1000 - EXPIRY_MARGIN_MS);
}

/** A form POST to the token endpoint, with this app's credentials on it. */
async function tokenRequest(fields) {
  const { data } = await axios.post(
    TOKEN_URL,
    new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...fields }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return data;
}

/**
 * Trade the code from the callback for a token pair. The state is what the
 * flow's PKCE verifier is worked out from.
 *
 * The response names the account (`user_id`), so there is no profile call.
 */
async function exchangeCode({ code, redirectUri, state }) {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: pkceVerifier(state),
    scope: SCOPES.join(' '),
  });
}

/**
 * A usable access token for this user, refreshing it first if it has expired.
 *
 * @throws {TidalAuthError} When there is no connection, or the refresh fails.
 */
async function getValidToken(userId) {
  const row = await prisma.oAuth.findUnique({
    where: { user_provider: { user: userId, provider: PROVIDER } },
  });
  if (!row) throw new TidalAuthError('Tidal is not connected');

  if (row.expires_at && row.expires_at.getTime() > Date.now()) return row.access_token;

  if (!row.refresh_token) {
    throw new TidalAuthError('Tidal connection has expired and cannot be refreshed');
  }

  let data;
  try {
    data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: row.refresh_token });
  } catch (error) {
    console.error('[tidal] Refresh failed:', error.response?.data ?? error.message);
    throw new TidalAuthError('Tidal connection is no longer valid');
  }

  await prisma.oAuth.update({
    where: { user_provider: { user: userId, provider: PROVIDER } },
    data: {
      access_token: data.access_token,
      // Kept unless a new one is issued; dropping it would break the next refresh.
      ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
      expires_at: expiryFrom(data.expires_in),
      ...(data.scope ? { scope: data.scope } : {}),
    },
  });

  return data.access_token;
}

const request = (config) => requestWithBackoff(config, {
  label: 'tidal',
  authError: () => new TidalAuthError('Tidal rejected the token'),
});

const headersFor = (accessToken, extra = {}) => ({
  Authorization: `Bearer ${accessToken}`,
  Accept: JSON_API,
  ...extra,
});

/**
 * A track's artist names, or none when Tidal will not say. One track's
 * missing credits cost that tie-break, not the playlist.
 */
async function trackArtists(accessToken, trackId) {
  try {
    const { data } = await request({
      method: 'get',
      url: `${API_URL}/tracks/${encodeURIComponent(trackId)}/relationships/artists`,
      params: { include: 'artists' },
      headers: headersFor(accessToken),
    });
    return includedNames(data, 'artists');
  } catch (error) {
    if (error instanceof TidalAuthError) throw error;
    console.error(`[tidal] Artists of track ${trackId}:`, error.response?.status ?? error.message);
    return [];
  }
}

/**
 * Find one track.
 *
 * No country is sent: searching as the user, Tidal answers for theirs, which
 * is the one the playlist will be played in.
 *
 * @returns {{ uri: string, name: string }|null} `uri` is the Tidal track id —
 *   named for what addItems takes, the same key as Spotify's result.
 */
async function findTrack(accessToken, track) {
  const q = searchQuery(track);
  if (!q) return null;

  const { data } = await request({
    method: 'get',
    url: `${API_URL}/searchResults`,
    params: { 'filter[query]': q, include: 'tracks' },
    headers: headersFor(accessToken),
  });
  const best = await chooseTrack(searchedTracks(data), track, (id) => trackArtists(accessToken, id));
  return best ? { uri: best.id, name: best.title } : null;
}

/**
 * Create an empty unlisted playlist on the connected account.
 *
 * Sent with an idempotency key, so a retry after a 429 replays the first
 * answer instead of creating a second playlist.
 */
async function createPlaylist(accessToken, { name, description }) {
  const { data } = await request({
    method: 'post',
    url: `${API_URL}/playlists`,
    headers: headersFor(accessToken, { 'Content-Type': JSON_API, 'Idempotency-Key': crypto.randomUUID() }),
    data: {
      data: {
        type: 'playlists',
        attributes: {
          name: String(name ?? '').slice(0, NAME_MAX),
          description: String(description ?? '').slice(0, DESCRIPTION_MAX),
          accessType: 'UNLISTED',
        },
      },
    },
  });
  return { id: data.data.id, url: playlistUrl(data.data) };
}

/** Add tracks to a playlist by id, in the order given. */
async function addItems(accessToken, playlistId, ids) {
  for (let i = 0; i < ids.length; i += ADD_CHUNK) {
    await request({
      method: 'post',
      url: `${API_URL}/playlists/${encodeURIComponent(playlistId)}/relationships/items`,
      // A key per chunk, kept across that chunk's retries: a 429 answered
      // after the add went through would otherwise add the chunk twice.
      headers: headersFor(accessToken, { 'Content-Type': JSON_API, 'Idempotency-Key': crypto.randomUUID() }),
      data: { data: ids.slice(i, i + ADD_CHUNK).map((id) => ({ type: 'tracks', id })) },
    });
  }
}

module.exports = {
  PROVIDER,
  LABEL,
  SCOPES,
  TidalAuthError,
  isConfigured,
  authorizeUrl,
  exchangeCode,
  expiryFrom,
  getValidToken,
  findTrack,
  createPlaylist,
  addItems,
};
