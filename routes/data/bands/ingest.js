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
const { checkDuplicateConcert, deduplicateByCoords, haversineKm } = require('../../../utils/concertDedup');
const { cleanLineupJson, canonicalBandName, lineupGrew } = require('../../../utils/lineupNames');
const { mergeTicketFields } = require('../../../utils/ticketState');
const auth = require('../../../auth/verifyJWT');
const roleCheck = require('../../../middlewares/roleCheck');
const prisma = require('../../../prisma/client');
const { logActivity } = require('../../../utils/activityLog');

const DAY_MS = 24 * 60 * 60 * 1000;
// Two positions further apart than this are two places, not one venue under
// two names. Bandsintown files a festival's acts under the grounds and under
// each stage, all at one spot.
const VENUE_MOVE_KM = 1;

/**
 * What changed about a show the scrapers already sent, when it has moved.
 *
 * A postponed or moved show keeps its event id, and used to keep its old date
 * and venue here for good: only prices, sale state and sold-out were updated,
 * and reconcile matches it by event id and looks no further.
 *
 * Only a show still to come moves, and only to a date still to come: a night
 * already been to has photographs filed under its date and venue. A time
 * of day is taken for the same date, but a bare date never replaces one. A
 * venue changes only with a position more than VENUE_MOVE_KM from the stored
 * one, so a stage name at the same grounds is not a move, and a new name with
 * no position cannot be told from one.
 *
 * @returns {object} fields for concert.update, empty when nothing moved
 */
function movedFields(existing, incoming, now = new Date()) {
  const moved = {};
  const was = existing.concert_date ? new Date(existing.concert_date) : null;
  if (!was || was <= now) return moved;

  const next = incoming.concert_date ? new Date(incoming.concert_date) : null;
  if (next && !Number.isNaN(next.getTime())) {
    const day = (d) => Math.floor(d.getTime() / DAY_MS);
    const untimed = (d) => d.getTime() % DAY_MS === 0;
    const startOfToday = day(now) * DAY_MS;
    if (next.getTime() >= startOfToday
      && (day(next) !== day(was) || (untimed(was) && !untimed(next)))) {
      moved.concert_date = next;
    }
  }

  const venue = typeof incoming.venue === 'string' ? incoming.venue.trim() : '';
  const [lat, lng] = [parseFloat(incoming.latitude), parseFloat(incoming.longitude)];
  const [oldLat, oldLng] = [parseFloat(existing.latitude), parseFloat(existing.longitude)];
  if (venue && venue !== existing.venue && Number.isFinite(lat) && Number.isFinite(lng)
    && (!Number.isFinite(oldLat) || !Number.isFinite(oldLng) || haversineKm(oldLat, oldLng, lat, lng) > VENUE_MOVE_KM)) {
    Object.assign(moved, { venue, latitude: String(incoming.latitude), longitude: String(incoming.longitude) });
  }
  return moved;
}

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
      // Only the scheduled sync announces what it inserts. A manual full sync
      // or a single band's sync stays quiet, and must not leave its shows
      // flagged for the next scheduled one to announce instead.
      const notify = req.body.notify === true;

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
              // The ticket fields through the same merge the duplicate path
              // uses. Written straight off the scrape, as they were, a source
              // that marks every listing in stock by default cleared the sale
              // day another source had found and said the show was selling —
              // which is an "on sale now" to every follower of it, days before
              // the sale opens.
              const tickets = mergeTicketFields(existingByEventId, concert);
              Object.assign(concertFieldUpdate, tickets);
              if (concert.price_min != null) concertFieldUpdate.price_min = concert.price_min;
              if (concert.price_max != null) concertFieldUpdate.price_max = concert.price_max;
              if (concert.price_currency != null) concertFieldUpdate.price_currency = concert.price_currency;
              // The bill as this scrape saw it, when it saw more of it than the
              // row holds. The lineup was read above to link what it could and
              // then thrown away, so an act joining a show with no Band row of
              // its own — most of a festival's acts — reached nothing that a
              // follower's lineup alert reads.
              if (lineupGrew(existingByEventId.metadata, metadata)) concertFieldUpdate.metadata = metadata;
              const moved = movedFields(existingByEventId, concert);
              Object.assign(concertFieldUpdate, moved);

              const becameSoldOut = tickets.sold_out === true;

              // An act joining a show already stored is news the way a new
              // show is: a festival's second act arrives exactly like this.
              const owesNotice = notify && toLink.length > 0;
              if (owesNotice && !existingByEventId.notify_pending) concertFieldUpdate.notify_pending = true;
              const notifyPending = existingByEventId.notify_pending || owesNotice;

              if (toLink.length > 0 || Object.keys(concertFieldUpdate).length > 0) {
                await Promise.all([
                  toLink.length > 0 && tx.concertBandReference.createMany({
                    data: toLink.map((band) => ({ concert: existingByEventId.id, band, notify_pending: notify })),
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
                    ...(Object.keys(moved).length && { moved: Object.keys(moved) }),
                    // Owed a notification, for an act just added or one that
                    // did not go out before: the scraper sends it.
                    ...(notifyPending && { notifyPending: true }),
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
                  ...(existingByEventId.notify_pending && { notifyPending: true }),
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

          const { isDuplicate, existingConcert, linked } = await checkDuplicateConcert({ concert, bandIds, bandNames, tx, notify });

          if (isDuplicate) {
            return {
              duplicate: {
                index: i,
                reason: concert.festival ? 'festival duplicate (merged bands)' : 'duplicate concert_date + venue + band combination',
                concertId: existingConcert.id,
                event_id: existingConcert.event_id || '',
                // The stored row keeps the event id of whichever scrape made it,
                // so this is how the scraper finds which of its own concerts
                // this one is.
                incoming_event_id: concert.event_id || null,
                name: existingConcert.name,
                bandCount: existingConcert.bands.length,
                ...((existingConcert.notify_pending || (notify && linked.length > 0)) && { notifyPending: true }),
              },
            };
          }

          // Find or create city record
          let cityId = null;
          if (concert.city && concert.country) {
            const coord = (v) => {
              const n = parseFloat(v);
              return Number.isFinite(n) ? n : null;
            };
            const latitude = coord(concert.latitude);
            const longitude = coord(concert.longitude);
            const hasCoords = latitude != null && longitude != null;

            const cityRecord = await tx.city.upsert({
              where: { name_country: { name: concert.city, country: concert.country } },
              create: {
                name: concert.city,
                country: concert.country,
                latitude: hasCoords ? latitude : null,
                longitude: hasCoords ? longitude : null,
                reachable: concert.reachable ?? null,
              },
              update: {
                // Never overwrite manually set flight_price. Coordinates are
                // backfilled below rather than here: what to write depends on
                // what the row already holds, which an upsert's update cannot
                // read.
                ...(concert.reachable && { reachable: concert.reachable }),
              },
              select: { id: true, latitude: true, longitude: true },
            });
            cityId = cityRecord.id;

            // Backfill only — which is what the update above always claimed to
            // do, while in fact writing whatever arrived. A city's stored point
            // moved to the venue of whichever show was scraped last, so two
            // rooms on opposite sides of a city kept dragging it between them,
            // and with it every distance and map pin drawn from the city rather
            // than the show. Written as a second statement, the way the
            // setlist.fm attendance route writes it.
            if (hasCoords && (cityRecord.latitude == null || cityRecord.longitude == null)) {
              await tx.city.update({ where: { id: cityId }, data: { latitude, longitude } });
            }
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
              notify_pending: notify,
              city_id: cityId,
              created_at: new Date(),
            },
          });

          await tx.concertBandReference.createMany({
            data: bandIds.map((band) => ({ concert: newConcert.id, band, notify_pending: notify })),
            skipDuplicates: true,
          });

          // Auto-link any other bands in the lineup (metadata) that exist in the DB
          const linkedSet = new Set(bandIds);
          const extraIds = lineupBandIds(metadata).filter((id) => !linkedSet.has(id));
          if (extraIds.length > 0) {
            await tx.concertBandReference.createMany({
              data: extraIds.map((band) => ({ concert: newConcert.id, band, notify_pending: notify })),
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
          // the transaction usable for the rest. It is released either way:
          // ROLLBACK TO keeps the savepoint, and a batch with many bad rows
          // would otherwise stack one open subtransaction per failure.
          await tx.$executeRaw`SAVEPOINT bulk_concert`;
          let outcome;
          try {
            outcome = await ingestOne(concert, i);
            await tx.$executeRaw`RELEASE SAVEPOINT bulk_concert`;
          } catch (error) {
            await tx.$executeRaw`ROLLBACK TO SAVEPOINT bulk_concert`;
            await tx.$executeRaw`RELEASE SAVEPOINT bulk_concert`;
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

            // Through logActivity, so each feed keeps to its length like
            // every other entry does.
            await Promise.all([...wishlistMap.entries()].map(([wishlistId, bandNames]) =>
              logActivity(wishlistId, 'SOLD_OUT', {
                concert_name: soldOut.name,
                city: soldOut.city,
                country: soldOut.country,
                concert_date: soldOut.concert_date,
                band_names: [...bandNames],
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
