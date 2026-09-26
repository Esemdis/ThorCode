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

        // One concert's worth of work. Returns what happened to it rather than
        // recording it, so the loop below can record it only once the concert's
        // savepoint has been released — a result pushed before a later
        // statement failed would report a row that was rolled back.
        const ingestOne = async (concert, i) => {
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
              // Deduplicated: the same band can arrive twice — once by id, once
              // by Ticketmaster id — and a repeated (concert, band) pair is a
              // unique violation that used to abort the whole transaction.
              const validIds = [...new Set(dbBands.filter(Boolean).map((b) => b.id))];

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
                    skipDuplicates: true,
                  }),
                  Object.keys(concertFieldUpdate).length > 0 && tx.concert.update({
                    where: { id: existingByEventId.id },
                    data: concertFieldUpdate,
                  }),
                ].filter(Boolean));
                return {
                  updated: {
                    index: i,
                    concertId: existingByEventId.id,
                    event_id: concert.event_id,
                    bandsAdded: toLink.length,
                    name: betterName || existingByEventId.name,
                    bandCount: existingByEventId._count.bands + toLink.length,
                  },
                  soldOut: becameSoldOut ? {
                    concertId: existingByEventId.id,
                    name: betterName || existingByEventId.name,
                    city: existingByEventId.city,
                    country: existingByEventId.country,
                    concert_date: existingByEventId.concert_date,
                  } : null,
                };
              }
              return {
                duplicate: {
                  index: i,
                  reason: 'event_id already exists',
                  concertId: existingByEventId.id,
                  event_id: concert.event_id,
                  name: existingByEventId.name,
                  bandCount: existingByEventId._count.bands,
                },
              };
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
          // Deduplicated for the same reason as above: one band listed twice is
          // one link, not a unique violation.
          const resolved = [...new Map(dbBands.filter(Boolean).map((b) => [b.id, b])).values()];
          const bandIds = resolved.map((b) => b.id);
          const bandNames = resolved.map((b) => b.name);

          const { isDuplicate, existingConcert } = await checkDuplicateConcert({ concert, bandIds, bandNames, tx });

          if (isDuplicate) {
            return {
              duplicate: {
                index: i,
                reason: concert.festival ? 'festival duplicate (merged bands)' : 'duplicate concert_date + venue + band combination',
                concertId: existingConcert.id,
                event_id: existingConcert.event_id || '',
                name: existingConcert.name,
                bandCount: existingConcert.bands.length,
              },
            };
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
            skipDuplicates: true,
          });

          // Auto-link any other bands in the lineup (metadata) that exist in the DB
          const linkedSet = new Set(bandIds);
          const extraIds = lineupBandIds(metadata).filter((id) => !linkedSet.has(id));
          if (extraIds.length > 0) {
            await tx.concertBandReference.createMany({
              data: extraIds.map((band) => ({ concert: newConcert.id, band })),
              skipDuplicates: true,
            });
          }

          return {
            inserted: {
              index: i,
              concertId: newConcert.id,
              event_id: newConcert.event_id,
              source: newConcert.source,
              name: newConcert.name,
              venue: newConcert.venue,
              city: newConcert.city,
              date: newConcert.concert_date,
              bandCount: bandIds.length,
            },
          };
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

          // A savepoint per concert, because one failing statement does not fail
          // alone: Postgres aborts the whole transaction, every later statement
          // is refused, and the COMMIT at the end quietly becomes a ROLLBACK.
          // Catching the error and carrying on — which is what this loop is for,
          // so one bad row does not cost the scraper the batch — used to answer
          // "inserted N" for a batch in which nothing at all was saved. Rolling
          // back to the savepoint discards just this concert's work and leaves
          // the transaction usable for the rest.
          await tx.$executeRaw`SAVEPOINT bulk_concert`;
          let outcome;
          try {
            outcome = await ingestOne(concert, i);
            await tx.$executeRaw`RELEASE SAVEPOINT bulk_concert`;
          } catch (error) {
            await tx.$executeRaw`ROLLBACK TO SAVEPOINT bulk_concert`;
            errors.push({ index: i, message: error.message });
            continue;
          }

          if (outcome.inserted) insertedConcerts.push(outcome.inserted);
          if (outcome.updated) updatedConcerts.push(outcome.updated);
          if (outcome.soldOut) newlySoldOut.push(outcome.soldOut);
          if (outcome.duplicate) duplicateConcerts.push(outcome.duplicate);
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
