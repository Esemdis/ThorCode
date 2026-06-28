const express = require('express');
const router = express.Router();
const { validationResult, body } = require('express-validator');
const axios = require('axios');
const { handleError, checkDuplicateConcert } = require('./helpers');
const { haversineKm, stringSimilarity, venueContains, deduplicateByCoords } = require('../../utils/concertDedup');

const auth = require('../../auth/verifyJWT');
const roleCheck = require('../../middlewares/roleCheck');
const { rateLimiter } = require('../../utils/rateLimiter');
const prisma = require('../../prisma/client');
const { Prisma } = require('@prisma/client');
const { setCache, getCache } = require('../../utils/cache');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MB_HEADERS = {
  'User-Agent': `${process.env.APP_NAME || 'ConcertMap'}/1.0 (${process.env.APP_CONTACT || 'contact@example.com'})`,
  'Accept': 'application/json',
};

// Fetch Songkick + Bandsintown URLs from MusicBrainz URL relationships.
// Uses MBID directly if known; otherwise searches by artist name first.
async function findSourceUrls(bandName, mbid = null) {
  let resolvedMbid = mbid;

  if (!resolvedMbid) {
    try {
      const searchRes = await axios.get('https://musicbrainz.org/ws/2/artist/', {
        params: { query: `artist:"${bandName}"`, limit: 1, fmt: 'json' },
        headers: MB_HEADERS,
        timeout: 10000,
      });
      resolvedMbid = searchRes.data?.artists?.[0]?.id ?? null;
      if (resolvedMbid) {
        console.log(`[findSourceUrls] MusicBrainz resolved "${bandName}" → ${resolvedMbid}`);
      } else {
        console.log(`[findSourceUrls] MusicBrainz found no artist for "${bandName}"`);
        return [null, null];
      }
    } catch (e) {
      console.error(`[findSourceUrls] MusicBrainz search failed for "${bandName}":`, e.message);
      return [null, null];
    }
    await sleep(1100); // MusicBrainz rate limit: 1 req/sec
  }

  try {
    const relRes = await axios.get(`https://musicbrainz.org/ws/2/artist/${resolvedMbid}`, {
      params: { inc: 'url-rels', fmt: 'json' },
      headers: MB_HEADERS,
      timeout: 10000,
    });
    const relations = relRes.data?.relations ?? [];
    let songkickUrl = null;
    let bandsintownUrl = null;
    for (const rel of relations) {
      const url = rel.url?.resource;
      if (!url) continue;
      if (!songkickUrl && url.includes('songkick.com')) songkickUrl = url.split('?')[0].replace(/\/$/, '');
      if (!bandsintownUrl && url.includes('bandsintown.com')) bandsintownUrl = url.split('?')[0].replace(/\/$/, '');
    }
    console.log(`[findSourceUrls] ${bandName} → songkick: ${songkickUrl}, bandsintown: ${bandsintownUrl}`);
    return [songkickUrl, bandsintownUrl];
  } catch (e) {
    console.error(`[findSourceUrls] MusicBrainz URL relations failed for "${bandName}" (${resolvedMbid}):`, e.message);
    return [null, null];
  }
}

// Defaults to 5 requests per 15 minutes per IP
const ticketmasterURL = 'https://app.ticketmaster.com/discovery/v2/';
const rateLimit = rateLimiter({
  message:
    'Too many requests to the Ticketmaster data route, please try again later.',
});

// Bulk insert concerts with deduplication
router.post(
  '/bulk',
  auth,
  roleCheck(['ADMIN', 'SYSTEM']),
  body('concerts')
    .isArray({ min: 1 })
    .withMessage('concerts must be a non-empty array'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      
      const { concerts } = req.body;

      const deduplicatedConcerts = deduplicateByCoords(concerts);

      const result = await prisma.$transaction(async (tx) => {
        const insertedConcerts = [];
        const updatedConcerts = [];
        const duplicateConcerts = [];
        const newlySoldOut = [];
        const errors = [];

        // Must be sequential — each insert affects subsequent duplicate checks within the tx
        for (const [i, concert] of deduplicatedConcerts.entries()) {
          if (!concert.country || !concert.venue || !concert.city) {
            errors.push({ index: i, message: 'Concert must have country, venue, and city fields' });
            continue;
          }
          if (!Array.isArray(concert.bands) || concert.bands.length === 0) {
            errors.push({ index: i, message: 'Concert must have at least one band' });
            continue;
          }

          try {
            // Check for duplicates by event_id if provided
            if (concert.event_id) {
              const existingByEventId = await tx.concert.findUnique({
                where: { event_id: concert.event_id },
                include: { _count: { select: { bands: true } } },
              });

              if (existingByEventId) {
                // Resolve bands by band_id or ticketmaster_id
                const dbBands = await Promise.all(
                  concert.bands.map((b) => {
                    if (b.band_id) return tx.band.findUnique({ where: { id: b.band_id } });
                    if (b.ticketmaster_id) return tx.band.findFirst({ where: { ticketmaster_id: b.ticketmaster_id } });
                    return null;
                  }),
                );
                let validIds = dbBands.filter(Boolean).map((b) => b.id);

                // Also auto-link any bands from the metadata lineup
                if (concert.metadata) {
                  try {
                    const lineupNames = JSON.parse(concert.metadata);
                    if (Array.isArray(lineupNames) && lineupNames.length > 0) {
                      const lineupBands = await tx.band.findMany({
                        where: { OR: lineupNames.map((n) => ({ name: { equals: n, mode: 'insensitive' } })) },
                        select: { id: true },
                      });
                      const validSet = new Set(validIds);
                      lineupBands.forEach((b) => { if (!validSet.has(b.id)) validIds.push(b.id); });
                    }
                  } catch (_) {}
                }

                const existingRefs = await tx.concertBandReference.findMany({
                  where: { concert: existingByEventId.id, band: { in: validIds } },
                  select: { band: true },
                });
                const linked = new Set(existingRefs.map((r) => r.band));
                const toLink = validIds.filter((id) => !linked.has(id));

                // Upgrade name if incoming has a better one (existing is "Band @ Venue" fallback)
                const isAtFormat = (s) => s.includes(' @ ') || / at /i.test(s);
                const existingIsAtFormat = isAtFormat(existingByEventId.name || '');
                const incomingIsAtFormat = isAtFormat(concert.name || '');
                const betterName = concert.name && existingIsAtFormat && !incomingIsAtFormat
                  ? concert.name : null;

                const concertFieldUpdate = {};
                if (betterName) concertFieldUpdate.name = betterName;
                if (concert.on_sale !== undefined) concertFieldUpdate.on_sale = concert.on_sale;
                if (concert.ticket_sale_start !== undefined) concertFieldUpdate.ticket_sale_start = concert.ticket_sale_start ? new Date(concert.ticket_sale_start) : null;
                if (concert.price_min != null) concertFieldUpdate.price_min = concert.price_min;
                if (concert.price_max != null) concertFieldUpdate.price_max = concert.price_max;
                if (concert.price_currency != null) concertFieldUpdate.price_currency = concert.price_currency;
                if (concert.sold_out !== undefined) concertFieldUpdate.sold_out = concert.sold_out ?? false;

                const becameSoldOut = concert.sold_out === true && !existingByEventId.sold_out;

                if (toLink.length > 0 || Object.keys(concertFieldUpdate).length > 0) {
                  await Promise.all([
                    toLink.length > 0 && tx.concertBandReference.createMany({
                      data: toLink.map((band) => ({ concert: existingByEventId.id, band })),
                    }),
                    Object.keys(concertFieldUpdate).length > 0 && tx.concert.update({
                      where: { id: existingByEventId.id },
                      data: concertFieldUpdate,
                    }),
                  ].filter(Boolean));
                  updatedConcerts.push({
                    index: i,
                    concertId: existingByEventId.id,
                    event_id: concert.event_id,
                    bandsAdded: toLink.length,
                    name: betterName || existingByEventId.name,
                    bandCount: existingByEventId._count.bands + toLink.length,
                  });
                  if (becameSoldOut) {
                    newlySoldOut.push({
                      concertId: existingByEventId.id,
                      name: betterName || existingByEventId.name,
                      city: existingByEventId.city,
                      country: existingByEventId.country,
                      concert_date: existingByEventId.concert_date,
                    });
                  }
                } else {
                  duplicateConcerts.push({
                    index: i,
                    reason: 'event_id already exists',
                    concertId: existingByEventId.id,
                    event_id: concert.event_id,
                    name: existingByEventId.name,
                    bandCount: existingByEventId._count.bands,
                  });
                }
                continue;
              }
            }

            // Resolve all bands in parallel
            if (concert.bands.some((b) => !b.ticketmaster_id && !b.band_id)) {
              throw new Error(`Invalid band data at index ${i}: ticketmaster_id or band_id required`);
            }
            const dbBands = await Promise.all(
              concert.bands.map((b) => {
                if (b.band_id) return tx.band.findUnique({ where: { id: b.band_id } });
                return tx.band.findFirst({ where: { ticketmaster_id: b.ticketmaster_id } });
              }),
            );
            const bandIds = dbBands.filter(Boolean).map((b) => b.id);

            const { isDuplicate, existingConcert } = await checkDuplicateConcert({ concert, bandIds, tx });

            if (isDuplicate) {
              duplicateConcerts.push({
                index: i,
                reason: concert.festival ? 'festival duplicate (merged bands)' : 'duplicate concert_date + venue + band combination',
                concertId: existingConcert.id,
                event_id: existingConcert.event_id || '',
                name: existingConcert.name,
                bandCount: existingConcert.bands.length,
              });
              continue;
            }

            // Find or create city record
            let cityId = null;
            if (concert.city && concert.country) {
              const cityRecord = await tx.city.upsert({
                where: { name_country: { name: concert.city, country: concert.country } },
                create: {
                  name: concert.city,
                  country: concert.country,
                  latitude:  concert.latitude  ? parseFloat(concert.latitude)  : null,
                  longitude: concert.longitude ? parseFloat(concert.longitude) : null,
                  reachable: concert.reachable ?? null,
                },
                update: {
                  // Only backfill missing coordinate data; never overwrite manually set flight_price
                  ...(concert.latitude  && { latitude:  parseFloat(concert.latitude)  }),
                  ...(concert.longitude && { longitude: parseFloat(concert.longitude) }),
                  ...(concert.reachable && { reachable: concert.reachable }),
                },
              });
              cityId = cityRecord.id;
            }

            const newConcert = await tx.concert.create({
              data: {
                country: concert.country,
                venue: concert.venue,
                city: concert.city,
                concert_date: concert.concert_date ? new Date(concert.concert_date) : null,
                on_sale: concert.on_sale ?? false,
                event_id: concert.event_id || null,
                latitude: concert.latitude || null,
                longitude: concert.longitude || null,
                metadata: concert.metadata || null,
                name: concert.name || null,
                ticket_sale_start: concert.ticket_sale_start ? new Date(concert.ticket_sale_start) : null,
                url: concert.url || null,
                festival: concert.festival || false,
                source: concert.source ?? null,
                price_min: concert.price_min ?? null,
                price_max: concert.price_max ?? null,
                price_currency: concert.price_currency ?? null,
                sold_out: concert.sold_out ?? false,
                reachable: concert.reachable ?? null,
                city_id: cityId,
                created_at: new Date(),
              },
            });

            await tx.concertBandReference.createMany({
              data: bandIds.map((band) => ({ concert: newConcert.id, band })),
            });

            // Auto-link any other bands in the lineup (metadata) that exist in the DB
            if (concert.metadata) {
              try {
                const lineupNames = JSON.parse(concert.metadata);
                if (Array.isArray(lineupNames) && lineupNames.length > 0) {
                  const lineupBands = await tx.band.findMany({
                    where: {
                      OR: lineupNames.map((n) => ({ name: { equals: n, mode: 'insensitive' } })),
                    },
                    select: { id: true },
                  });
                  const linkedSet = new Set(bandIds);
                  const extraIds = lineupBands.map((b) => b.id).filter((id) => !linkedSet.has(id));
                  if (extraIds.length > 0) {
                    await tx.concertBandReference.createMany({
                      data: extraIds.map((band) => ({ concert: newConcert.id, band })),
                    });
                  }
                }
              } catch (_) {
                // malformed metadata — skip silently
              }
            }

            insertedConcerts.push({
              index: i,
              concertId: newConcert.id,
              event_id: newConcert.event_id,
              source: newConcert.source,
              name: newConcert.name,
              venue: newConcert.venue,
              city: newConcert.city,
              date: newConcert.concert_date,
              bandCount: bandIds.length,
            });
          } catch (error) {
            errors.push({ index: i, message: error.message });
          }
        }

        return {
          inserted: insertedConcerts.length,
          updated: updatedConcerts.length,
          duplicates: duplicateConcerts.length,
          errors: errors.length,
          newlySoldOut,
          details: {
            insertedConcerts,
            updatedConcerts,
            duplicateConcerts,
            errors,
          },
        };
      }, { timeout: 60000 });

      // Create SOLD_OUT activity logs for every wishlist that has a band at a newly sold-out concert
      if (result.newlySoldOut.length > 0) {
        for (const soldOut of result.newlySoldOut) {
          try {
            const refs = await prisma.concertBandReference.findMany({
              where: { concert: soldOut.concertId },
              select: {
                band_rel: {
                  select: {
                    name: true,
                    wishlists: { select: { wishlist_id: true } },
                  },
                },
              },
            });

            const wishlistMap = new Map(); // wishlist_id -> Set of band names
            for (const ref of refs) {
              for (const wl of ref.band_rel.wishlists) {
                if (!wishlistMap.has(wl.wishlist_id)) wishlistMap.set(wl.wishlist_id, new Set());
                wishlistMap.get(wl.wishlist_id).add(ref.band_rel.name);
              }
            }

            await Promise.all([...wishlistMap.entries()].map(([wishlistId, bandNames]) =>
              prisma.activityLog.create({
                data: {
                  wishlist_id: wishlistId,
                  type: 'SOLD_OUT',
                  data: JSON.stringify({
                    concert_name: soldOut.name,
                    city: soldOut.city,
                    country: soldOut.country,
                    concert_date: soldOut.concert_date,
                    band_names: [...bandNames],
                  }),
                },
              })
            ));
          } catch (e) {
            console.error('[SoldOut] Failed to create activity log:', e.message);
          }
        }
      }

      res.status(200).json(result);
    } catch (error) {
      console.error('Error bulk inserting concerts:', error);
      res.status(500).json({ error: 'Internal server error', details: error.message });
    }
  },
);

// Search bands by name for autocomplete
router.get('/bands/search', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q || q.trim().length < 2) {
      return res.json([]);
    }

    const searchTerm = q.trim();

    const bands = await prisma.band.findMany({
      where: {
        name: {
          contains: searchTerm,
          mode: 'insensitive',
        },
      },
      select: {
        id: true,
        name: true,
      },
      orderBy: [
        {
          name: 'asc',
        },
      ],
      take: parseInt(limit, 10),
    });

    // Sort results to prioritize matches that start with the search term
    const sortedBands = bands.sort((a, b) => {
      const aStartsWith = a.name
        .toLowerCase()
        .startsWith(searchTerm.toLowerCase());
      const bStartsWith = b.name
        .toLowerCase()
        .startsWith(searchTerm.toLowerCase());

      if (aStartsWith && !bStartsWith) return -1;
      if (!aStartsWith && bStartsWith) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json(sortedBands);
  } catch (error) {
    console.error('Error searching bands:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List all bands with concert counts (number of ConcertBandReferences)
router.get('/upcoming/bands', async (req, res) => {
  try {
    const now = new Date();
    const bands = await prisma.band.findMany({
      select: {
        id: true,
        name: true,
        songkick_url: true,
        bandsintown_url: true,
        _count: { select: { concerts: { where: { concert_rel: { concert_date: { gte: now } } } } } },
      },
      orderBy: { name: 'asc' },
    });

    const mapped = bands.map((b) => ({
      id: b.id,
      name: b.name,
      songkick_url: b.songkick_url,
      bandsintown_url: b.bandsintown_url,
      concertCount: b._count.concerts,
    }));

    // Enrich with next upcoming concert (date & country)
    await Promise.all(
      mapped.map(async (b) => {
        try {
          const next = await prisma.concert.findFirst({
            where: {
              concert_date: { gte: now },
              bands: { some: { band: b.id } }, // concerts having this band
            },
            select: { concert_date: true, country: true },
            orderBy: { concert_date: 'asc' },
          });
          if (next) {
            b.nextConcertDate = next.concert_date; // raw Date; frontend can format
            b.nextConcertCountry = next.country;
          } else {
            b.nextConcertDate = null;
            b.nextConcertCountry = null;
          }
        } catch (e) {
          console.error(`Error fetching next concert for band ${b.id} (${b.name}):`, e);
          b.nextConcertDate = null;
          b.nextConcertCountry = null;
        }
      }),
    );

    res.json(mapped);
  } catch (error) {
    console.error('Error fetching bands:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/bands', async (req, res) => {
  try {
    const bands = await prisma.band.findMany({
      select: { id: true, ticketmaster_id: true, name: true, MBID: true, songkick_url: true, bandsintown_url: true },
      orderBy: { created_at: 'asc' },
    });
    res.json(bands);
  } catch (error) {
    console.error('Error fetching bands:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post(
  '/bands/:bandId/sync-concerts',
  rateLimit,
  auth,
  roleCheck(['ADMIN', 'SYSTEM']),
  async (req, res) => {
    const { bandId } = req.params;
    try {
      // Fetch the band from the database
      const band = await prisma.band.findUnique({
        where: { id: parseInt(bandId) },
        select: { id: true, name: true, ticketmaster_id: true, songkick_url: true, bandsintown_url: true },
      });

      if (!band) {
        return res.status(404).json({ error: 'Band not found' });
      }

      if (!band.songkick_url && !band.bandsintown_url) {
        return res.status(400).json({ error: 'No Songkick or Bandsintown URL set for this band' });
      }

      // Call the Python service to sync concerts for this band
      const pythonServiceUrl = process.env.PYTHON_SERVICE_URL;
      const syncResponse = await axios.post(
        `${pythonServiceUrl}/sync/${band.id}`,
        { songkick_url: band.songkick_url ?? null, bandsintown_url: band.bandsintown_url ?? null, ticketmaster_id: band.ticketmaster_id ?? null, band_name: band.name },
      );

      res.status(200).json({
        status: 'success',
        message: 'Band concerts synced successfully',
        bandId: band.id,
        syncDetails: syncResponse.data,
      });
    } catch (error) {
      if (error.response?.status === 404) {
        return res.status(404).json({ error: 'Band or sync endpoint not found' });
      } else if (error.response?.status === 429) {
        return res.status(429).json({ error: 'Too many requests, please try again later.' });
      }
      console.error('Error syncing concerts:', error.message);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  },
);

// POST /bands/:bandId/reconcile
// Called after a single-band sync. Compares fresh scraped concerts (source of truth)
// against future DB concerts for this band. For any DB concert with no match in the
// fresh data, unlinks this band from it (rather than deleting outright) and returns
// the other participating bands for re-sync. Those bands' own reconcile pass decides
// whether the concert is legitimate for them; if no bands remain it becomes an orphan
// and is deleted.
router.post(
  '/bands/:bandId/reconcile',
  auth,
  roleCheck(['ADMIN', 'SYSTEM']),
  async (req, res) => {
    const bandId = parseInt(req.params.bandId, 10);
    if (Number.isNaN(bandId)) return res.status(400).json({ error: 'Invalid band id' });

    const { upcoming } = req.body;
    if (!Array.isArray(upcoming)) return res.status(400).json({ error: 'upcoming must be an array' });

    // If scraper returned nothing, skip — likely a scrape failure, not a genuinely empty schedule
    if (upcoming.length === 0) {
      return res.json({ stale_removed: 0, resync_bands: [], skipped: true, reason: 'empty_upcoming' });
    }

    const now = new Date();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const toUtcDay = (d) => { const x = new Date(d); return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()); };

    const freshByEventId = new Map(upcoming.filter((c) => c.event_id).map((c) => [c.event_id, c]));

    const dbConcerts = await prisma.concert.findMany({
      where: {
        concert_date: { gt: now },
        bands: { some: { band: bandId } },
      },
      include: {
        bands: {
          include: {
            band_rel: {
              select: { id: true, name: true, songkick_url: true, bandsintown_url: true, ticketmaster_id: true },
            },
          },
        },
      },
    });

    const staleIds = [];
    const resyncBandMap = new Map();

    for (const dbConcert of dbConcerts) {
      if (dbConcert.event_id && freshByEventId.has(dbConcert.event_id)) continue;

      const dbDay = toUtcDay(dbConcert.concert_date);
      const dbLat = parseFloat(dbConcert.latitude);
      const dbLng = parseFloat(dbConcert.longitude);
      const dayWindow = dbConcert.festival ? 3 : 2;

      const hasMatch = upcoming.some((fresh) => {
        if (!fresh.concert_date) return false;
        if (Math.abs(toUtcDay(fresh.concert_date) - dbDay) / ONE_DAY_MS > dayWindow) return false;

        // When both sides have venue names, require venue similarity — area alone is not
        // enough (e.g. two different venues in the same city would otherwise match).
        // 5km fallback handles same venue with a localised name on one side.
        if (dbConcert.venue && fresh.venue) {
          if (stringSimilarity(dbConcert.venue, fresh.venue) >= 0.7 || venueContains(dbConcert.venue, fresh.venue)) return true;
          const freshLat = parseFloat(fresh.latitude);
          const freshLng = parseFloat(fresh.longitude);
          if (!isNaN(dbLat) && !isNaN(dbLng) && !isNaN(freshLat) && !isNaN(freshLng)) {
            if (haversineKm(dbLat, dbLng, freshLat, freshLng) <= 8) return true;
          }
          return false;
        }

        // No venue on one side — fall back to coordinates or city name
        const freshLat = parseFloat(fresh.latitude);
        const freshLng = parseFloat(fresh.longitude);
        if (!isNaN(dbLat) && !isNaN(dbLng) && !isNaN(freshLat) && !isNaN(freshLng)) {
          if (haversineKm(dbLat, dbLng, freshLat, freshLng) <= 8) return true;
        }

        return dbConcert.city && fresh.city && stringSimilarity(dbConcert.city, fresh.city) >= 0.7;
      });

      if (!hasMatch) {
        staleIds.push(dbConcert.id);
        for (const ref of dbConcert.bands) {
          if (ref.band_rel.id !== bandId) resyncBandMap.set(ref.band_rel.id, ref.band_rel);
        }
      }
    }

    if (staleIds.length === 0) return res.json({ stale_removed: 0, resync_bands: [] });

    // Unlink this band from stale concerts rather than deleting immediately.
    // The participating bands' own reconcile pass will decide if the concert is
    // valid for them; any concert left with no bands after unlinking is an orphan.
    await prisma.$transaction(async (tx) => {
      await tx.concertBandReference.deleteMany({ where: { concert: { in: staleIds }, band: bandId } });
      const orphans = await tx.concert.findMany({
        where: { id: { in: staleIds }, bands: { none: {} } },
        select: { id: true },
      });
      if (orphans.length > 0) {
        await tx.concert.deleteMany({ where: { id: { in: orphans.map((c) => c.id) } } });
      }
    });

    const resyncBands = [...resyncBandMap.values()].map((b) => ({
      id: b.id, name: b.name,
      songkick_url: b.songkick_url, bandsintown_url: b.bandsintown_url, ticketmaster_id: b.ticketmaster_id,
    }));

    console.log(`[reconcile] Band ${bandId}: removed ${staleIds.length} stale concert(s), re-syncing: ${resyncBands.map((b) => b.name).join(', ') || 'none'}`);

    return res.json({ stale_removed: staleIds.length, resync_bands: resyncBands });
  },
);

router.post(
  '/bands',
  rateLimit,
  auth,
  roleCheck(['ADMIN', 'USER']),
  body('name')
    .optional()
    .isString()
    .notEmpty()
    .withMessage('Band name must be a non-empty string'),
  body('ticketmaster_id')
    .optional()
    .isString()
    .notEmpty()
    .withMessage('Ticketmaster ID must be a non-empty string'),
  body('wishlistId')
    .optional()
    .isInt()
    .withMessage('Wishlist ID must be an integer'),
  async (req, res) => {
    try {

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, ticketmaster_id, wishlistId } = req.body;

      // Validate that either name or ticketmaster_id is provided
      if (!name && !ticketmaster_id) {
        return res.status(400).json({
          error: "Either 'name' or 'ticketmaster_id' must be provided",
        });
      }

      const bandName = name ? name.trim() : null;
      const ticketmasterId = ticketmaster_id ? ticketmaster_id.trim() : null;

      // Check if band already exists in the database
      let existingBand = null;

      if (ticketmasterId) {
        existingBand = await prisma.band.findUnique({
          where: { ticketmaster_id: ticketmasterId },
        });
      } else if (bandName) {
        existingBand = await prisma.band.findUnique({
          where: { name: bandName },
        });
      }

      if (existingBand) {
        return res.status(409).json({ error: 'Band already exists.' });
      }

      // Fetch band data from Ticketmaster API
      let bandData;
      let resolvedTicketmasterId;
      try {
        if (ticketmasterId) {
          // Fetch band data by Ticketmaster ID
          const response = await axios.get(
            `${ticketmasterURL}attractions/${ticketmasterId}.json`,
            {
              params: {
                apikey: process.env.TICKETMASTER_KEY,
              },
            },
          );
          if (!response.data) {
            return res
              .status(404)
              .json({ error: 'Band not found with that Ticketmaster ID' });
          }

          bandData = response.data;
          resolvedTicketmasterId = response.data.id;
        } else {
          // Fetch band data from Ticketmaster API by name
          const response = await axios.get(`${ticketmasterURL}attractions.json`, {
            params: {
              apikey: process.env.TICKETMASTER_KEY,
              keyword: bandName,
              size: 1,
            },
          });

          if (!response.data._embedded?.attractions?.[0]) {
            return res.status(404).json({ error: 'No band found.' });
          }

          bandData = response.data._embedded.attractions[0];
          resolvedTicketmasterId = bandData.id;
        }
      } catch (error) {
        if (error.response?.status === 404) {
          return res.status(404).json({ error: 'Band not found on Ticketmaster.' });
        } else if (error.response?.status === 429) {
          return res
            .status(429)
            .json({ error: 'Too many requests, please try again later.' });
        }
        console.error('Error fetching band from Ticketmaster:', error);
        return res.status(500).json({ error: 'Internal server error' });
      }

      // Fetch MBID from MusicBrainz
      let mbid = null;
      try {
        const mbResponse = await axios.get(
          'https://musicbrainz.org/ws/2/artist/',
          {
            params: { query: `artist:"${bandData.name}"`, limit: 1, fmt: 'json' },
            headers: {
              'User-Agent': `${process.env.APP_NAME}/${process.env.APP_VERSION} (${process.env.APP_CONTACT})`,
            },
          },
        );
        mbid = mbResponse.data?.artists?.[0]?.id ?? null;
      } catch (mbError) {
        console.error('Error fetching MBID from MusicBrainz:', mbError.message);
      }
      // Create band in database
      const newBand = await prisma.band.create({
        data: {
          name: bandData.name,
          ticketmaster_id: resolvedTicketmasterId,
          created_at: new Date(),
          MBID: mbid,
        },
      });

      // Add to wishlist if provided
      if (wishlistId) {
        await prisma.wishlistBandReference.create({
          data: {
            wishlist_id: wishlistId,
            band_id: newBand.id,
          },
        });
      }

      // Respond immediately — sync happens in the background after URL discovery
      res.status(201).json({
        status: 'success',
        band: {
          id: newBand.id,
          name: newBand.name,
          ticketmaster_id: newBand.ticketmaster_id,
          mbid: newBand.MBID,
        },
        sync: { status: 'queued' },
      });

      // Discover Songkick + Bandsintown URLs, save them, THEN trigger sync so all
      // three sources are available in one pass — avoids the race where sync fires
      // before URLs are known.
      findSourceUrls(newBand.name, mbid).then(async ([songkickUrl, bandsintownUrl]) => {
        console.log(`[findSourceUrl] ${newBand.name} → songkick: ${songkickUrl}, bandsintown: ${bandsintownUrl}`);
        if (songkickUrl || bandsintownUrl) {
          await prisma.band.update({
            where: { id: newBand.id },
            data: {
              ...(songkickUrl    && { songkick_url:    songkickUrl }),
              ...(bandsintownUrl && { bandsintown_url: bandsintownUrl }),
            },
          }).catch((e) => console.error(`[findSourceUrl] DB update failed for ${newBand.name}:`, e.message));
        }
        const pythonServiceUrl = process.env.PYTHON_SERVICE_URL;
        await axios.post(
          `${pythonServiceUrl}/sync/${newBand.id}`,
          { songkick_url: songkickUrl || null, bandsintown_url: bandsintownUrl || null, ticketmaster_id: resolvedTicketmasterId, band_name: newBand.name },
        );
        console.log(`[findSourceUrl] Sync queued for ${newBand.name}`);
      }).catch((e) => console.error(`[findSourceUrl] Background sync failed for ${newBand.name}:`, e.message));
    } catch (error) {
      console.error('Error creating band:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// POST /bands/quick-add
// Minimal band creation from known name + MBID (e.g. from Setlist.fm).
// Does not do Ticketmaster lookup — adds straight to DB and optionally to a wishlist.
router.post('/bands/quick-add', auth, async (req, res) => {
  try {
    const { name, mbid, wishlistId, tier } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const validTiers = ['LOVE', 'LIKE', 'FOLLOW'];
    const resolvedTier = validTiers.includes(tier) ? tier : 'FOLLOW';

    // Check for existing band by MBID or name
    const existing = await prisma.band.findFirst({
      where: mbid ? { MBID: mbid } : { name: name.trim() },
      select: { id: true, name: true },
    });

    let band = existing;
    if (!band) {
      band = await prisma.band.create({
        data: { name: name.trim(), MBID: mbid ?? null, created_at: new Date() },
        select: { id: true, name: true },
      });
    }

    // Add to wishlist if provided (skip if already there)
    if (wishlistId) {
      const wid = parseInt(wishlistId, 10);
      if (!Number.isNaN(wid)) {
        await prisma.wishlistBandReference.upsert({
          where: { band_wishlist: { band_id: band.id, wishlist_id: wid } },
          create: { band_id: band.id, wishlist_id: wid, tier: resolvedTier },
          update: {},
        });
      }
    }

    return res.status(201).json({ band });
  } catch (error) {
    console.error('[bands/quick-add] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all upcoming concerts for a specific band
router.get('/bands/:bandId/upcoming', async (req, res) => {
  try {
    const bandId = parseInt(req.params.bandId, 10);
    if (Number.isNaN(bandId)) {
      return res.status(400).json({ error: 'Invalid band id' });
    }

    const band = await prisma.band.findUnique({
      where: { id: bandId },
      select: { id: true, name: true, songkick_url: true, bandsintown_url: true, setlist: true, MBID: true },
    });

    if (!band) {
      return res.status(404).json({ error: 'Band not found' });
    }

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

    res.json({ band, upcoming: formatted });
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

    // Respond immediately — URL discovery runs in the background
    res.json({ status: 'searching', message: `Looking up URLs for ${band.name} in the background` });

    findSourceUrls(band.name, band.MBID).then(([songkickUrl, bandsintownUrl]) => {
      if (!songkickUrl)    console.warn(`\n⚠️  [refresh-urls] WARNING: No Songkick URL found for "${band.name}" (MBID: ${band.MBID ?? 'none'})\n`);
      if (!bandsintownUrl) console.warn(`\n⚠️  [refresh-urls] WARNING: No Bandsintown URL found for "${band.name}" (MBID: ${band.MBID ?? 'none'})\n`);
      console.log(`[refresh-urls] ${band.name} → songkick: ${songkickUrl}, bandsintown: ${bandsintownUrl}`);
      if (songkickUrl || bandsintownUrl) {
        prisma.band.update({
          where: { id: bandId },
          data: {
            ...(songkickUrl    && { songkick_url:    songkickUrl }),
            ...(bandsintownUrl && { bandsintown_url: bandsintownUrl }),
          },
        }).catch((e) => console.error(`[refresh-urls] DB update failed for ${band.name}:`, e.message));
      }
    }).catch(() => {});
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
            await tx.concert.deleteMany({
              where: { id: { in: orphanConcertIds } },
            });
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
router.get('/bands/ticketmaster-search', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q || q.trim().length < 2) {
      return res.json([]);
    }

    const searchTerm = q.trim();

    try {
      const response = await axios.get(`${ticketmasterURL}attractions.json`, {
        params: {
          apikey: process.env.TICKETMASTER_KEY,
          keyword: searchTerm,
          size: Math.min(parseInt(limit, 10), 20), // Cap at 20 for API limits
        },
      });

      if (!response.data._embedded || !response.data._embedded.attractions) {
        return res.json([]);
      }

      const bands = response.data._embedded.attractions.map((attraction) => ({
        id: attraction.id,
        name: attraction.name,
        url: attraction.url || null,
        // Include image if available
        image:
          attraction.images && attraction.images.length > 0
            ? attraction.images[0].url
            : null,
        // Include genre if available
        classifications: attraction.classifications
          ? attraction.classifications
              .map((c) => ({
                genre: c.genre?.name || null,
                subGenre: c.subGenre?.name || null,
              }))
              .filter((c) => c.genre || c.subGenre)
          : [],
      }));

      res.json(bands);
    } catch (error) {
      if (error.response?.status === 404) {
        return res.json([]);
      } else if (error.response?.status === 429) {
        const payload = handleError('wishlist', 429);
        return res.status(429).json(payload);
      }
      console.error('Error searching Ticketmaster:', error);
      const payload = handleError('wishlist', 500);
      return res.status(500).json(payload);
    }
  } catch (error) {
    console.error('Error in Ticketmaster search:', error);
    const payload = handleError('wishlist', 500);
    return res.status(500).json(payload);
  }
});

router.post('/bands/sync-all', auth, roleCheck(['ADMIN']), async (_req, res) => {
  try {
    const pythonServiceUrl = process.env.PYTHON_SERVICE_URL;
    const syncResponse = await axios.post(`${pythonServiceUrl}/trigger`);
    res.status(200).json({ status: 'success', ...syncResponse.data });
  } catch (error) {
    console.error('Error triggering full sync:', error.message);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// POST /sync-weather — proxy to Python weather sync (ADMIN only)
router.post('/sync-weather', auth, roleCheck(['ADMIN']), async (_req, res) => {
  try {
    const pythonServiceUrl = process.env.PYTHON_SERVICE_URL;
    await axios.post(`${pythonServiceUrl}/sync-weather`, {}, { timeout: 300000 });
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Error triggering weather sync:', error.message);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// POST /bands/sync-setlists — proxy to Python setlist sync (ADMIN only)
router.post('/bands/sync-setlists', auth, roleCheck(['ADMIN']), async (_req, res) => {
  try {
    const pythonServiceUrl = process.env.PYTHON_SERVICE_URL;
    await axios.post(`${pythonServiceUrl}/sync-setlists`, {}, { timeout: 300000 });
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Error triggering setlist sync:', error.message);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// GET /bandsintown/enrich-pending — future BIT concerts with numeric event IDs that can be enriched
router.get('/bandsintown/enrich-pending', auth, roleCheck(['ADMIN', 'SYSTEM']), async (_req, res) => {
  try {
    const concerts = await prisma.concert.findMany({
      where: {
        source: 'bandsintown',
        concert_date: { gte: new Date() },
        event_id: { startsWith: 'bit_' },
      },
      select: { id: true, event_id: true },
    });
    // Only numeric IDs — hashed JSON-LD IDs can't be used to reconstruct the event URL
    const pending = concerts.filter((c) => /^bit_\d+$/.test(c.event_id));
    res.json(pending);
  } catch (error) {
    console.error('[enrich-pending] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /weather-pending — future concerts with coordinates but no weather data yet (SYSTEM only)
router.get('/weather-pending', auth, roleCheck(['SYSTEM']), async (_req, res) => {
  try {
    const in16Days = new Date(Date.now() + 16 * 24 * 60 * 60 * 1000);
    const concerts = await prisma.concert.findMany({
      where: {
        concert_date: { gte: new Date() },
        latitude: { not: null },
        longitude: { not: null },
        OR: [
          { weather: { equals: Prisma.DbNull } },
          { concert_date: { lte: in16Days } },
        ],
      },
      select: { id: true, latitude: true, longitude: true, concert_date: true },
    });
    res.json(concerts);
  } catch (error) {
    console.error('[weather-pending] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /bands/setlist-pending — bands with no setlist or stale setlist (> 3 days)
// ?force=true returns all bands regardless of when they were last updated (SYSTEM only)
router.get('/bands/setlist-pending', auth, roleCheck(['SYSTEM']), async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const where = force ? {} : {
      OR: [
        { setlist: { equals: Prisma.DbNull } },
        { setlist_updated_at: { lt: threeDaysAgo } },
      ],
    };
    const bands = await prisma.band.findMany({
      where,
      select: { id: true, name: true, MBID: true },
    });
    res.json(bands);
  } catch (error) {
    console.error('[setlist-pending] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /bands/setlists/bulk — store fetched setlists for multiple bands (SYSTEM only)
router.patch('/bands/setlists/bulk', auth, roleCheck(['SYSTEM']), async (req, res) => {
  try {
    const updates = req.body; // [{ id, setlist }]
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Expected non-empty array of { id, setlist }' });
    }
    await Promise.all(
      updates.map(({ id, setlist }) =>
        prisma.band.update({
          where: { id },
          data: { setlist, setlist_updated_at: new Date() },
        })
      )
    );
    res.json({ ok: true, updated: updates.length });
  } catch (error) {
    console.error('[setlists/bulk] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:concertId/enrich-lineup — match scraped artist names to known bands, link missing ones
router.post('/:concertId/enrich-lineup', auth, roleCheck(['ADMIN', 'SYSTEM']), async (req, res) => {
  const concertId = parseInt(req.params.concertId, 10);
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

    for (const name of band_names) {
      if (!name || !name.trim()) continue;
      const needle = name.trim().toLowerCase();

      let bestBand = null;
      let bestScore = 0;
      for (const band of allBands) {
        const score = stringSimilarity(needle, (band.name || '').toLowerCase());
        if (score > bestScore) { bestScore = score; bestBand = band; }
      }

      if (bestScore >= 0.75 && bestBand && !existingIds.has(bestBand.id)) {
        toLink.push(bestBand.id);
        existingIds.add(bestBand.id);
        matches.push({ input_name: name, band_name: bestBand.name, band_id: bestBand.id, score: Math.round(bestScore * 100) });
      }
    }

    // Resolve the best name to store: prefer a real event name from the enricher;
    // only overwrite the existing name if we have something better.
    const concertUpdate = { metadata: JSON.stringify((band_names || []).filter(Boolean)) };
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
      prisma.concert.update({
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

    const page = parseInt(req.query.page, 10) || 1;

    const cacheKey = `sfm:setlists:${bandId}:p${page}`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const band = await prisma.band.findUnique({
      where: { id: bandId },
      select: { MBID: true },
    });

    if (!band) return res.status(404).json({ error: 'Band not found' });
    if (!band.MBID) return res.status(404).json({ error: 'Band has no MBID' });

    const sfmRes = await axios.get(
      `https://api.setlist.fm/rest/1.0/artist/${band.MBID}/setlists`,
      {
        headers: { 'x-api-key': process.env.SETLIST_API_KEY, Accept: 'application/json' },
        params: { p: page },
        timeout: 15000,
      },
    );

    const raw = sfmRes.data;
    const setlists = (raw.setlist || []).map((s) => {
      const venue = s.venue || {};
      const city = venue.city || {};
      const sets = (s.sets?.set || []);
      const songs = sets.flatMap((set) =>
        (set.song || []).map((song) => ({
          name: song.name || '',
          cover: song.cover?.name ?? null,
          tape: song.tape ?? false,
        })),
      );
      return {
        setlistfm_id: s.id,
        date: s.eventDate,
        venue: venue.name ?? null,
        city: city.name ?? null,
        country: city.country?.code ?? null,
        tour: s.tour?.name ?? null,
        songs,
        url: s.url ?? null,
      };
    });

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

    const sfmRes = await axios.get(
      `https://api.setlist.fm/rest/1.0/setlist/${id}`,
      {
        headers: { 'x-api-key': process.env.SETLIST_API_KEY, Accept: 'application/json' },
        timeout: 15000,
      },
    );

    const s = sfmRes.data;
    const venue = s.venue || {};
    const city = venue.city || {};
    const sets = (s.sets?.set || []);
    const songs = sets.flatMap((set) =>
      (set.song || []).map((song) => ({
        name: song.name || '',
        cover: song.cover?.name ?? null,
        tape: song.tape ?? false,
      })),
    );

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
      setlistfm_id: s.id,
      date: s.eventDate,
      venue: venue.name ?? null,
      city: city.name ?? null,
      country: city.country?.code ?? null,
      tour: s.tour?.name ?? null,
      songs,
      url: s.url ?? null,
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
