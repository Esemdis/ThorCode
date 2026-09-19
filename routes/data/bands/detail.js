/**
 * One band: its shows, its neighbours, its record.
 *
 * Split out of routes/data/bands.js, which had grown to 1571 lines and
 * twenty-six endpoints. bands.js now mounts this and its siblings in the
 * order they were declared in, so the routing surface is unchanged — see
 * the manifest test in bands.test.js.
 */
const express = require('express');
const router = express.Router();
const { validationResult, body } = require('express-validator');
const axios = require('axios');
const { handleError, checkDuplicateConcert } = require('../helpers');
const { cleanLineupNames, cleanLineupJson, canonicalBandName } = require('../../../utils/lineupNames');
const { searchArtists, getArtists } = require('../../../utils/spotify');
const { getArtistInfo } = require('../../../utils/lastfm');
const { relevantArtists } = require('../../../utils/artistSearch');
const { resolveArtistImages } = require('../../../utils/bandImages');
const { matchBandToSpotify, backfillSpotifyIds } = require('../../../utils/bandSpotifyMatch');
const { findSourceUrls } = require('../../../utils/bandSourceUrls');
const { detachAttendances } = require('../../../utils/mediaDetach');
const auth = require('../../../auth/verifyJWT');
const roleCheck = require('../../../middlewares/roleCheck');
const prisma = require('../../../prisma/client');
const { setCache, getCache } = require('../../../utils/cache');

// Last.fm has no batch endpoint, so enriching a row costs a request. Three is
// what fits on screen without scrolling the dropdown.
const LASTFM_ROWS = 3;

// Bound to the module's cache and Spotify client once, so no route has to
// remember which three functions resolveArtistImages needs.
const bandImageDeps = { getCache, setCache, getArtists };

// Get all upcoming concerts for a specific band
router.get('/bands/:bandId/upcoming', async (req, res) => {
  try {
    const bandId = parseInt(req.params.bandId, 10);
    if (Number.isNaN(bandId)) {
      return res.status(400).json({ error: 'Invalid band id' });
    }

    const band = await prisma.band.findUnique({
      where: { id: bandId },
      select: {
        id: true, name: true, songkick_url: true, bandsintown_url: true, setlist: true, MBID: true,
        spotify_id: true, spotify_checked_at: true,
      },
    });

    if (!band) {
      return res.status(404).json({ error: 'Band not found' });
    }

    // Opening a band is the one place a Spotify search is affordable — one
    // band, one request, once ever — so this is where unmatched bands get their
    // id, and the overview picks the photo up from there on the next load.
    const spotifyId = await matchBandToSpotify(band);
    const images = await resolveArtistImages([spotifyId], bandImageDeps);
    const bandWithImage = { ...band, image: images[spotifyId] ?? null, spotify_checked_at: undefined };

    const now = new Date();
    const concerts = await prisma.concert.findMany({
      where: {
        concert_date: { gte: now },
        bands: { some: { band: bandId } },
      },
      select: {
        id: true,
        name: true,
        venue: true,
        city: true,
        country: true,
        concert_date: true,
        on_sale: true,
        ticket_sale_start: true,
        url: true,
        festival: true,
        latitude: true,
        longitude: true,
        event_id: true,
        metadata: true,
        bands: {
          select: {
            band_rel: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { concert_date: 'asc' },
    });

    const formatted = concerts.map((c) => {
      // All bands tracked in DB for this concert
      const trackedBands = c.bands.map((b) => b.band_rel);
      const trackedNames = new Set(trackedBands.map((b) => b.name.toLowerCase()));

      // Full lineup from metadata (JSON array of name strings)
      let metadataNames = [];
      try { metadataNames = JSON.parse(c.metadata || '[]'); } catch {}

      // Merge: tracked bands keep their id; metadata-only names get id: null
      const metadataOnly = metadataNames
        .filter((n) => !trackedNames.has(n.toLowerCase()))
        .map((n) => ({ id: null, name: n }));

      return {
        ...c,
        other_bands: [...trackedBands, ...metadataOnly],
        bands: undefined,
        metadata: undefined,
      };
    });

    res.json({ band: bandWithImage, upcoming: formatted });
  } catch (error) {
    console.error('Error fetching upcoming concerts for band:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /bands/:bandId/related — similar artists from Last.fm
// Uses MBID for accuracy when available, falls back to artist name.
router.get('/bands/:bandId/related', auth, async (req, res) => {
  const bandId = parseInt(req.params.bandId, 10);
  if (Number.isNaN(bandId)) return res.status(400).json({ error: 'Invalid band id' });

  const apiKey = process.env.LASTFM_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Last.fm API key not configured' });

  try {
    const cacheKey = `lfm:related:${bandId}`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const band = await prisma.band.findUnique({
      where: { id: bandId },
      select: { id: true, name: true, MBID: true },
    });
    if (!band) return res.status(404).json({ error: 'Band not found' });

    const params = {
      method: 'artist.getSimilar',
      api_key: apiKey,
      format: 'json',
      limit: 12,
      autocorrect: 1,
    };
    if (band.MBID) params.mbid = band.MBID;
    else params.artist = band.name;

    const lfmRes = await axios.get('https://ws.audioscrobbler.com/2.0/', {
      params,
      timeout: 8000,
    });

    // Last.fm returns { error, message } on failure
    if (lfmRes.data?.error) {
      return res.status(404).json({ error: lfmRes.data.message || 'Artist not found on Last.fm' });
    }

    const raw = lfmRes.data?.similarartists?.artist ?? [];
    const related = raw.map((a) => ({
      name: a.name,
      match: Math.round(parseFloat(a.match) * 100), // 0–100
      mbid: a.mbid || null,
      url: a.url || null,
    }));

    const payload = { band: { id: band.id, name: band.name }, related };
    await setCache(cacheKey, payload, 86400); // 24h — similar artists are stable
    return res.json(payload);
  } catch (e) {
    console.error('[related-artists]', e.message);
    return res.status(500).json({ error: 'Failed to fetch related artists' });
  }
});

router.post(
  '/bands/:bandId/refresh-urls',
  auth,
  roleCheck(['ADMIN']),
  async (req, res) => {
    const bandId = parseInt(req.params.bandId, 10);
    if (Number.isNaN(bandId)) return res.status(400).json({ error: 'Invalid band id' });

    const band = await prisma.band.findUnique({ where: { id: bandId }, select: { name: true, MBID: true } });
    if (!band) return res.status(404).json({ error: 'Band not found' });

    // Awaited, not fired and forgotten. This used to answer `{status:'searching'}`
    // straight away and do the lookup in the background, which meant the caller
    // could never be told anything: the client reads `songkick_url` and
    // `bandsintown_url` off this response, so the fields it fills were always
    // undefined and the button appeared to do nothing however well the lookup
    // went. A background failure could not reach the user either — it went to
    // the server log, and the band kept its missing urls.
    //
    // The wait is short enough to hold a request open: one MusicBrainz call
    // when the band has an MBID, and two separated by the mandatory 1.1s of
    // rate-limit spacing when it has to be searched for by name.
    try {
      const [songkickUrl, bandsintownUrl] = await findSourceUrls(band.name, band.MBID);

      if (!songkickUrl)    console.warn(`[refresh-urls] No Songkick url for "${band.name}" (MBID: ${band.MBID ?? 'none'})`);
      if (!bandsintownUrl) console.warn(`[refresh-urls] No Bandsintown url for "${band.name}" (MBID: ${band.MBID ?? 'none'})`);

      await prisma.band.update({
        where: { id: bandId },
        data: {
          ...(songkickUrl    && { songkick_url:    songkickUrl }),
          ...(bandsintownUrl && { bandsintown_url: bandsintownUrl }),
          source_urls_checked_at: new Date(),
        },
      });

      // Always both keys, null when nothing was found: the client distinguishes
      // "looked and found nothing" from "the call failed", and an absent key
      // reads as neither.
      return res.json({ songkick_url: songkickUrl ?? null, bandsintown_url: bandsintownUrl ?? null });
    } catch (e) {
      // Not stamped: MusicBrainz being unreachable is not evidence the urls do
      // not exist, so the band stays queued for the next backfill sweep. Same
      // rule as bandSourceUrlBackfill.
      console.error(`[refresh-urls] Lookup failed for ${band.name}:`, e.message);
      return res.status(502).json({ error: 'Could not reach MusicBrainz. Try again in a moment.' });
    }
  },
);

router.patch(
  '/bands/:bandId',
  auth,
  roleCheck(['ADMIN']),
  body('songkick_url')
    .optional({ nullable: true })
    .custom((val) => {
      if (val === null || val === '') return true;
      try { new URL(val); } catch { throw new Error('songkick_url must be a valid URL'); }
      if (!val.includes('songkick.com')) throw new Error('songkick_url must be a songkick.com URL');
      return true;
    }),
  body('bandsintown_url')
    .optional({ nullable: true })
    .custom((val) => {
      if (val === null || val === '') return true;
      try { new URL(val); } catch { throw new Error('bandsintown_url must be a valid URL'); }
      if (!val.includes('bandsintown.com')) throw new Error('bandsintown_url must be a bandsintown.com URL');
      return true;
    }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const bandId = parseInt(req.params.bandId, 10);
      if (Number.isNaN(bandId)) {
        return res.status(400).json({ error: 'Invalid band id' });
      }
      const { songkick_url, bandsintown_url } = req.body;
      if ((songkick_url && !bandsintown_url) || (!songkick_url && bandsintown_url)) {
        const missing = !songkick_url ? 'bandsintown_url' : 'songkick_url';
        console.warn(`[PATCH /bands/${bandId}] WARNING: only one source URL provided — ${missing} is missing`);
      }
      const data = {};
      if (songkick_url !== undefined)    data.songkick_url    = songkick_url    ? songkick_url.split('?')[0]    || null : null;
      if (bandsintown_url !== undefined) data.bandsintown_url = bandsintown_url ? bandsintown_url.split('?')[0] || null : null;
      const updated = await prisma.band.update({
        where: { id: bandId },
        data,
        select: { id: true, name: true, songkick_url: true, bandsintown_url: true },
      });
      res.json(updated);
    } catch (error) {
      if (error.code === 'P2025') {
        return res.status(404).json({ error: 'Band not found' });
      }
      console.error('Error updating band:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Delete a band and all related references; remove orphan concerts
router.delete(
  '/bands/:bandId',
  auth,
  roleCheck(['ADMIN']),
  async (req, res) => {
    try {
      const bandId = parseInt(req.params.bandId, 10);
      if (Number.isNaN(bandId)) {
        return res.status(400).json({ error: 'Invalid band id' });
      }

      // Fetch band & related concert references first
      const band = await prisma.band.findUnique({
        where: { id: bandId },
        include: { concerts: { select: { concert: true } } },
      });

      if (!band) {
        return res.status(404).json({ error: 'Band not found' });
      }

      const concertIds = band.concerts.map((r) => r.concert);

      const result = await prisma.$transaction(async (tx) => {
        const wishlistRefsDeleted = await tx.wishlistBandReference.deleteMany({
          where: { band_id: bandId },
        });

        const concertRefsDeleted = await tx.concertBandReference.deleteMany({
          where: { band: bandId },
        });

        // Delete the band itself
        await tx.band.delete({ where: { id: bandId } });

        let orphanConcertIds = [];
        if (concertIds.length) {
          // Find concerts that now have zero bands
          const orphans = await tx.concert.findMany({
            where: {
              id: { in: concertIds },
              bands: { none: {} },
            },
            select: { id: true },
          });
          orphanConcertIds = orphans.map((c) => c.id);
          if (orphanConcertIds.length) {
            // Detach before the attendance rows go, or the restricting foreign
            // key fails the whole transaction. See utils/mediaDetach.js for why
            // the key restricts rather than cascades. Passed tx, not prisma: a
            // rollback here must not leave media rows deleted while the band
            // and concert it belonged to survive.
            await detachAttendances(tx, orphanConcertIds);
            await tx.concertAttendance.deleteMany({ where: { concert_id: { in: orphanConcertIds } } });
            await tx.concert.deleteMany({ where: { id: { in: orphanConcertIds } } });
          }
        }

        return {
          deletedBandId: bandId,
          removedWishlistReferences: wishlistRefsDeleted.count,
          removedConcertReferences: concertRefsDeleted.count,
          removedConcerts: orphanConcertIds,
        };
      });

      res.json(result);
    } catch (error) {
      console.error('Error deleting band:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Search bands on Ticketmaster to get their IDs (helpful for disambiguation)
/**
 * GET /bands/artist-search?q=
 *
 * Artists to add, from Spotify. This replaced a Ticketmaster attractions
 * search, which answered a band query with films, plays, a basketball team,
 * tribute acts and multi-act bills, and which 404'd anything it did not carry.
 * Spotify's catalogue is recording artists and nothing else, so the noise is
 * gone rather than filtered.
 *
 * Genres and listener counts are Last.fm's — Spotify gives a Development Mode
 * app neither, on any endpoint.
 */
router.get('/bands/artist-search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json([]);

    const searchTerm = q.trim();
    const cacheKey = `artist:search:${searchTerm.toLowerCase()}`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    let artists;
    try {
      artists = await searchArtists(searchTerm);
    } catch (error) {
      console.error('[spotify] Artist search failed:', error.response?.data ?? error.message);
      const payload = handleError('wishlist', 502);
      return res.status(502).json(payload);
    }

    // Spotify's search recommends as much as it matches, so a query for
    // "architects" comes back with Spiritbox behind it. Narrow to the name
    // before anything else looks at the list.
    const rows = relevantArtists(artists, searchTerm).map((artist) => ({
      id: artist.id,
      name: artist.name,
      image: artist.images?.[0]?.url ?? null,
      spotifyUrl: artist.external_urls?.spotify ?? null,
    }));

    // Last.fm has no batch endpoint, so enrichment costs a request per artist
    // and only the rows you actually read get it.
    const withInfo = await Promise.all(rows.map(async (row, i) => {
      if (i >= LASTFM_ROWS) return { ...row, lastfm: null };

      const artistKey = `lfm:artist:${canonicalBandName(row.name)}`;
      const hit = await getCache(artistKey);
      // Wrapped rather than stored bare: "we looked and Last.fm has nothing" is
      // worth caching, and a bare null is indistinguishable from a miss.
      if (hit) return { ...row, lastfm: hit.info };

      try {
        const info = await getArtistInfo(row.name);
        await setCache(artistKey, { info }, 604800); // 7d — tags and listener counts move slowly
        return { ...row, lastfm: info };
      } catch (error) {
        // Never cached: a timeout is about today, not about the artist.
        console.warn('[lastfm] Artist info failed:', error.response?.status ?? error.message);
        return { ...row, lastfm: null };
      }
    }));

    await setCache(cacheKey, withInfo, 21600); // 6h
    res.json(withInfo);
  } catch (error) {
    console.error('Error in artist search:', error);
    const payload = handleError('wishlist', 500);
    return res.status(500).json(payload);
  }
});

module.exports = router;
