// The network half of artist enrichment. The decisions — which tags survive,
// whether an autocorrected name can be trusted — are in utils/artistTags.js
// and are tested there; this file only talks to Last.fm.

const axios = require('axios');
const { shapeArtistInfo } = require('./artistTags');

const API_URL = 'https://ws.audioscrobbler.com/2.0/';

// Matches the timeout on the existing artist.getSimilar call in
// routes/data/bands.js. This sits in a search path, so a slow third party has
// to give up well before the user does.
const TIMEOUT_MS = 8000;

/**
 * Tags and listener count for one artist, by name.
 *
 * @returns {Promise<{tags: string[], listeners: number|null, lastfmUrl: string|null}|null>}
 *   Null when Last.fm has no such artist, when it autocorrected to a different
 *   one, or when no API key is configured.
 * @throws When the request itself fails, so the caller can avoid caching it.
 */
async function getArtistInfo(name) {
  const apiKey = process.env.LASTFM_API_KEY;
  if (!apiKey) return null;

  const { data } = await axios.get(API_URL, {
    params: {
      method: 'artist.getInfo',
      api_key: apiKey,
      format: 'json',
      artist: name,
      autocorrect: 1,
    },
    timeout: TIMEOUT_MS,
  });

  return shapeArtistInfo(data, name);
}

module.exports = { getArtistInfo };
