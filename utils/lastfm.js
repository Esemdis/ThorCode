// The network half of artist enrichment. The decisions — which tags survive,
// whether an autocorrected name can be trusted — are in utils/artistTags.js
// and are tested there; this file only talks to Last.fm.

const axios = require('axios');
const { shapeArtistInfo } = require('./artistTags');
const { setCache, getCache } = require('./cache');

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

/**
 * Similar artists from Last.fm, by MBID when the band has one and by name
 * otherwise. Cached for a day: similar artists are stable. Shared by
 * GET /bands/:bandId/related and the weekly recap.
 *
 * @param {{id: number, name: string, MBID: string|null}} band
 * @returns {Promise<{band: {id: number, name: string}, related: Array}|{error: string}>}
 *   `{error}` when Last.fm does not know the artist.
 * @throws When the request itself fails, so nothing is cached.
 */
async function getRelated(band) {
  const cacheKey = `lfm:related:${band.id}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const params = {
    method: 'artist.getSimilar',
    api_key: process.env.LASTFM_API_KEY,
    format: 'json',
    limit: 12,
    autocorrect: 1,
  };
  if (band.MBID) params.mbid = band.MBID;
  else params.artist = band.name;

  const { data } = await axios.get(API_URL, { params, timeout: TIMEOUT_MS });
  // Last.fm returns { error, message } on failure
  if (data?.error) return { error: data.message || 'Artist not found on Last.fm' };

  const related = (data?.similarartists?.artist ?? []).map((a) => ({
    name: a.name,
    match: Math.round(parseFloat(a.match) * 100), // 0–100
    mbid: a.mbid || null,
    url: a.url || null,
  }));
  const payload = { band: { id: band.id, name: band.name }, related };
  await setCache(cacheKey, payload, 86400);
  return payload;
}

module.exports = { getArtistInfo, getRelated };
