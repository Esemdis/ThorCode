/**
 * Setlists, and the concerts reconstructed from them.
 *
 * Split out of routes/data/bands.js, which had grown to 1571 lines and
 * twenty-six endpoints. bands.js now mounts this and its siblings in the
 * order they were declared in, so the routing surface is unchanged — see
 * the manifest test in bands.test.js.
 */
const express = require('express');
const router = express.Router();
const { validationResult, body } = require('express-validator');
const { cleanLineupNames, cleanLineupJson, canonicalBandName } = require('../../../utils/lineupNames');
const auth = require('../../../auth/verifyJWT');
const roleCheck = require('../../../middlewares/roleCheck');
const prisma = require('../../../prisma/client');
const { setCache, getCache } = require('../../../utils/cache');
// Called through the module rather than destructured, so a test can stand in
// for setlist.fm on the router's own copy of it.
const setlistFm = require('../../../utils/setlistFm');

// POST /:concertId/enrich-lineup — match scraped artist names to known bands, link missing ones
router.post('/:concertId/enrich-lineup', auth, roleCheck(['ADMIN', 'SYSTEM']), async (req, res) => {
  const concertId = parseInt(req.params.concertId, 10);
  if (Number.isNaN(concertId)) return res.status(400).json({ error: 'Invalid concert id' });
  const { band_names, event_name } = req.body;

  if ((!Array.isArray(band_names) || band_names.length === 0) && !event_name) {
    return res.json({ linked: 0, matches: [] });
  }

  try {
    const [allBands, existing] = await Promise.all([
      prisma.band.findMany({ select: { id: true, name: true } }),
      prisma.concertBandReference.findMany({
        where: { concert: concertId },
        select: { band: true },
      }),
    ]);

    const existingIds = new Set(existing.map((r) => r.band));
    const toLink = [];
    const matches = [];

    // The enricher posts link text straight off the event page, so a name can
    // arrive as "Counterparts266K Followers" — clean before matching and before
    // storing, or a support act on the wishlist stays an unlinked string.
    const lineup = cleanLineupNames(band_names);

    // Matched on the canonical form rather than a similarity score. The score
    // this replaced put "Alestorm" on "Halestorm" at 0.93 and "Nothing" on
    // "Nothing More" at 0.75 — close enough to link, different enough to put a
    // show on the map that the band is not playing.
    const bandsByCanonical = new Map();
    for (const band of allBands) {
      const key = canonicalBandName(band.name);
      if (key && !bandsByCanonical.has(key)) bandsByCanonical.set(key, band);
    }

    for (const name of lineup) {
      const match = bandsByCanonical.get(canonicalBandName(name));
      if (match && !existingIds.has(match.id)) {
        toLink.push(match.id);
        existingIds.add(match.id);
        matches.push({ input_name: name, band_name: match.name, band_id: match.id });
      }
    }

    // Resolve the best name to store: prefer a real event name from the enricher;
    // only overwrite the existing name if we have something better.
    //
    // A post carrying only an event name leaves the lineup alone — it used to
    // write "[]" over whatever the JSON-LD scrape had already found.
    const concertUpdate = {};
    if (lineup.length > 0) concertUpdate.metadata = JSON.stringify(lineup);
    if (event_name) {
      const existing = await prisma.concert.findUnique({ where: { id: concertId }, select: { name: true } });
      const currentName = existing?.name || '';
      // Apply the scraped name if the concert has no name or only a "Band @ Venue" fallback
      if (!currentName || currentName.includes(' @ ') || currentName.includes(' at ')) {
        concertUpdate.name = event_name;
      }
    }

    await Promise.all([
      toLink.length > 0 && prisma.concertBandReference.createMany({
        data: toLink.map((bandId) => ({ concert: concertId, band: bandId })),
        skipDuplicates: true,
      }),
      Object.keys(concertUpdate).length > 0 && prisma.concert.update({
        where: { id: concertId },
        data: concertUpdate,
      }),
    ].filter(Boolean));

    res.json({ linked: toLink.length, matches });
  } catch (error) {
    console.error(`[enrich-lineup] Error for concert ${concertId}:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/bands/:bandId/setlist-history', auth, async (req, res) => {
  try {
    const bandId = parseInt(req.params.bandId, 10);
    if (Number.isNaN(bandId)) return res.status(400).json({ error: 'Invalid band id' });

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

    const cacheKey = `sfm:setlists:${bandId}:p${page}`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const band = await prisma.band.findUnique({
      where: { id: bandId },
      select: { MBID: true },
    });

    if (!band) return res.status(404).json({ error: 'Band not found' });
    // An MBID goes into setlist.fm's URL path, and one can arrive through
    // quick-add from a client, so anything not shaped like one is treated as
    // having none.
    if (!setlistFm.isMbid(band.MBID)) return res.status(404).json({ error: 'Band has no MBID' });

    const raw = await setlistFm.fetchArtistSetlists(band.MBID, page);
    const setlists = (raw.setlist || []).map(setlistFm.setlistSummary);

    const payload = {
      setlists,
      total: raw.total ?? setlists.length,
      page: raw.page ?? page,
      itemsPerPage: raw.itemsPerPage ?? 20,
    };
    await setCache(cacheKey, payload, 21600); // 6h
    return res.json(payload);
  } catch (error) {
    console.error('[setlist-history] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /data/concerts/setlist-lookup?id=:setlistfm_id
// Fetch a specific setlist by Setlist.fm ID and return preview data + DB band match
router.get('/setlist-lookup', auth, async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id parameter' });
    // Pasted straight into setlist.fm's URL path before, with the server's API
    // key attached — so "../artist/…" or a "?" reached whichever endpoint the
    // caller liked.
    if (!setlistFm.isSetlistId(id)) return res.status(400).json({ error: 'That is not a setlist.fm id' });

    const s = await setlistFm.fetchSetlistById(id);

    const artistMbid = s.artist?.mbid ?? null;
    const artistName = s.artist?.name ?? null;

    // Match artist MBID to a band in the DB
    let band = null;
    if (artistMbid) {
      band = await prisma.band.findFirst({
        where: { MBID: artistMbid },
        select: { id: true, name: true },
      });
    }

    return res.json({
      ...setlistFm.setlistSummary(s),
      artist: { name: artistName, mbid: artistMbid },
      band: band ?? null,
    });
  } catch (error) {
    if (error.response?.status === 404) {
      return res.status(404).json({ error: 'Setlist not found' });
    }
    console.error('[setlist-lookup] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
