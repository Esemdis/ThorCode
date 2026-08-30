/**
 * Concerts arriving from the scrapers.
 *
 * Split out of routes/data/bands.js, which had grown to 1571 lines and
 * twenty-six endpoints. bands.js now mounts this and its siblings in the
 * order they were declared in, so the routing surface is unchanged — see
 * the manifest test in bands.test.js.
 */
const express = require('express');
const router = express.Router();
const { validationResult, body } = require('express-validator');
const { handleError, checkDuplicateConcert } = require('../helpers');
const { haversineKm, stringSimilarity, venueContains, deduplicateByCoords } = require('../../../utils/concertDedup');
const { cleanLineupNames, cleanLineupJson, canonicalBandName } = require('../../../utils/lineupNames');
const auth = require('../../../auth/verifyJWT');
const roleCheck = require('../../../middlewares/roleCheck');
const prisma = require('../../../prisma/client');

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

        // Every band once, keyed by canonical name, so a lineup entry is matched
        // the same way here as in enrich-lineup. The exact match this replaces
        // linked "Architects" but not "Architects (UK)", so which path a bill
        // arrived by decided whether the band ended up on it. /bulk creates no
        // bands, so one snapshot holds for the whole request.
        const allBands = await tx.band.findMany({ select: { id: true, name: true } });
        const bandsByCanonical = new Map();
        for (const band of allBands) {
          const key = canonicalBandName(band.name);
          if (key && !bandsByCanonical.has(key)) bandsByCanonical.set(key, band.id);
        }
        const lineupBandIds = (json) => {
          try {
            const names = JSON.parse(json);
            if (!Array.isArray(names)) return [];
            return [...new Set(
              names.map((n) => bandsByCanonical.get(canonicalBandName(n))).filter((id) => id !== undefined),
            )];
          } catch {
            return [];
          }
        };

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
            // Scraped lineup names carry follower counts and profile suffixes
            // that stop them matching band.name. Clean once here so the two
            // auto-link lookups below and the row we store all see the same
            // names.
            const metadata = cleanLineupJson(concert.metadata);

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
                const validSet = new Set(validIds);
                for (const id of lineupBandIds(metadata)) {
                  if (!validSet.has(id)) { validSet.add(id); validIds.push(id); }
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
                metadata,
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
            const linkedSet = new Set(bandIds);
            const extraIds = lineupBandIds(metadata).filter((id) => !linkedSet.has(id));
            if (extraIds.length > 0) {
              await tx.concertBandReference.createMany({
                data: extraIds.map((band) => ({ concert: newConcert.id, band })),
              });
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

module.exports = router;
