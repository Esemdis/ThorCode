/**
 * The Discord webhook digest.
 *
 * Split out of routes/data/wishlists.js, which had grown to 1473 lines and
 * twenty-one endpoints. wishlists.js mounts this and its siblings in their
 * original declaration order — the manifest test in wishlists.test.js pins
 * the resulting surface.
 *
 * Two passes post here, both to a webhook belonging to the wishlist's own
 * owner. The first covers bands on that wishlist; the second covers
 * NotificationSubscription rows, and replaced a single global webhook in the
 * scraper that pinged one person about every band in the database — including
 * bands only other users had ever asked for.
 */
const express = require("express");
const router = express.Router();
const { validationResult, body } = require("express-validator");
const axios = require("axios");
const auth = require("../../../auth/verifyJWT");
const roleCheck = require("../../../middlewares/roleCheck");
const prisma = require("../../../prisma/client");
const { matchesByUser, followedBandsByUser } = require("../../../utils/notificationMatch");
const { buildDiscordEmbeds } = require("../../../utils/discordEmbeds");
const { logActivity } = require("./shared");

// The concert row the subscription pass matches against. Deliberately the same
// selection runNotificationDigest makes, because the two share the matcher and
// a field missing here would silently stop matching rather than fail.
const CONCERT_SELECT = {
  id: true,
  name: true,
  venue: true,
  city: true,
  country: true,
  concert_date: true,
  url: true,
  metadata: true,
  city_id: true,
  bands: { select: { band_rel: { select: { id: true, name: true } } } },
};

/**
 * Post concerts to a webhook and say which of them arrived.
 *
 * buildDiscordEmbeds makes one field per concert, in order, so each embed
 * covers the next fields.length of them. A busy batch is several posts, and
 * when a later one fails the shows in the earlier ones have still arrived:
 * marking the whole batch failed would send those again on the retry.
 *
 * @returns {Promise<{ delivered: object[], undelivered: object[], error: Error|null }>}
 */
async function postConcerts(webhook, { title, concerts, content }) {
  const embeds = buildDiscordEmbeds({ title, concerts });
  let sent = 0;
  for (const [i, embed] of embeds.entries()) {
    // The mention rides the first message only — one buzz per batch, not one
    // per embed, and a busy night can be several embeds.
    const payload = content && i === 0 ? { content, embeds: [embed] } : { embeds: [embed] };
    try {
      await axios.post(webhook, payload, { timeout: 10000 });
    } catch (error) {
      return { delivered: concerts.slice(0, sent), undelivered: concerts.slice(sent), error };
    }
    sent += embed.fields.length;
  }
  return { delivered: concerts, undelivered: [], error: null };
}

// Discord turning a post down for good: a deleted webhook (404), a revoked
// one (401, 403), a payload it will never take (400). Retried, those fail the
// same way every sync until the show has passed. A timeout, a rate limit, a
// 5xx or no answer at all is worth another go.
function failedForGood(error) {
  const status = error.response?.status;
  return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

const concertIdsOf = (concerts) => concerts.map((c) => c.concert_id ?? c.id).filter((id) => Number.isInteger(id));

/**
 * Who has had which show, and which shows are still owed to someone.
 *
 * A show stays pending while any recipient's post of it failed in a way worth
 * retrying, and the retry goes only where there is no delivery on record.
 * Scraper builds older than concert_id send shows this cannot track, which
 * are posted as before and never held.
 */
async function deliveryLedger(concertIds) {
  const rows = concertIds.length
    ? await prisma.concertDelivery.findMany({
        where: { concert_id: { in: concertIds } },
        select: { concert_id: true, wishlist_id: true },
      })
    : [];
  const had = new Set(rows.map((r) => `${r.concert_id}:${r.wishlist_id}`));
  const held = new Set();

  return {
    held,
    /** The concerts this wishlist has not had yet. */
    unsent: (wishlistId, concerts) => concerts.filter((c) => {
      const id = c.concert_id ?? c.id;
      return !Number.isInteger(id) || !had.has(`${id}:${wishlistId}`);
    }),
    /** Posts them, records what arrived, and holds what failed for a retry. */
    async send(wishlistId, webhook, post) {
      const { delivered, undelivered, error } = await postConcerts(webhook, post);
      const arrived = concertIdsOf(delivered);
      if (arrived.length) {
        await prisma.concertDelivery.createMany({
          data: arrived.map((id) => ({ concert_id: id, wishlist_id: wishlistId })),
          skipDuplicates: true,
        });
        for (const id of arrived) had.add(`${id}:${wishlistId}`);
      }
      if (error && !failedForGood(error)) for (const id of concertIdsOf(undelivered)) held.add(id);
      return error;
    },
  };
}

// Discord reads <@id> in `content` as a ping. Anything else there would be
// arbitrary text posted into the channel on the strength of a settings blob,
// so only a bare snowflake is honoured.
function mentionFor(settings) {
  const id = settings && typeof settings === "object" ? settings.discord_user_id : null;
  return typeof id === "string" && /^\d+$/.test(id) ? `<@${id}>` : null;
}

// POST /wishlists/notify — Discord notifications for new concerts (SYSTEM/ADMIN)
router.post(
  "/wishlists/notify",
  [auth, roleCheck(["ADMIN", "SYSTEM"]), body("bands").isArray({ min: 1 }).withMessage("bands must be a non-empty array")],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

      const { bands } = req.body;
      const requestIds = [...new Set(concertIdsOf(bands.flatMap((b) => b.concerts ?? [])))];
      const ledger = await deliveryLedger(requestIds);

      // All wishlists — needed for activity logs regardless of webhook
      const allWishlists = await prisma.wishlist.findMany({
        include: {
          bands: {
            include: { band_rel: { select: { id: true, name: true, ticketmaster_id: true } } },
          },
        },
      });

      // Discord notifications — only wishlists with a webhook
      const notifications = allWishlists
        .filter((w) => w.discord_webhook)
        .map((wishlist) => {
          const matchedBands = bands.filter((b) =>
            wishlist.bands.some((ref) => ref.band_rel.id === b.band_id),
          );
          return { wishlist, matchedBands };
        })
        .filter(({ matchedBands }) => matchedBands.length > 0);

      // Log wishlists that matched bands but have no webhook configured
      const noWebhookCount = allWishlists.filter((w) => !w.discord_webhook && bands.some((b) =>
        w.bands.some((ref) => ref.band_rel.id === b.band_id)
      )).length;
      if (noWebhookCount > 0) {
        console.log(`[Discord] ${noWebhookCount} wishlist(s) matched but have no webhook configured — skipping`);
      }

      // What the wishlist pass already told each wishlist about, so the
      // subscription pass below does not repeat it. Subscribing to a band that
      // is also on your wishlist is the ordinary case, not an edge one.
      const reportedByWishlist = new Map();

      await Promise.all(
        notifications.map(async ({ wishlist, matchedBands }) => {
          const reported = new Set();
          reportedByWishlist.set(wishlist.id, reported);
          for (const band of matchedBands) {
            for (const concert of band.concerts ?? []) {
              if (Number.isInteger(concert.concert_id)) reported.add(concert.concert_id);
            }
            // A retried show goes only to the wishlists that did not get it.
            const concerts = ledger.unsent(wishlist.id, band.concerts ?? []);
            if (concerts.length === 0) continue;
            const e = await ledger.send(wishlist.id, wishlist.discord_webhook, {
              title: `New concerts: ${band.name}`, concerts,
            });
            if (e) {
              console.error(`[Discord] Failed to notify wishlist ${wishlist.id} for band "${band.name}":`, e.response?.status ?? e.message);
            }
          }
        }),
      );

      const subscriptionNotified = await notifySubscribers(bands, allWishlists, reportedByWishlist, ledger);

      // Activity logs — all wishlists that have the band, only when concerts
      // were inserted. A show whose post failed somewhere comes back on the
      // next sync, and the feeds already have it: only the shows they have
      // not been told about are logged.
      const announced = new Set(requestIds.length
        ? (await prisma.concert.findMany({
            where: { id: { in: requestIds }, announced_at: { not: null } },
            select: { id: true, announced_at: true },
          })).filter((c) => c.announced_at != null).map((c) => c.id)
        : []);
      for (const wishlist of allWishlists) {
        const matchedBands = bands.filter(
          (b) => b.inserted > 0 && wishlist.bands.some((ref) => ref.band_rel.id === b.band_id),
        );
        for (const band of matchedBands) {
          const all = band.concerts || [];
          const fresh = all.filter((c) => !announced.has(c.concert_id));
          if (fresh.length === 0) continue;
          const countries = [...new Set(fresh.map((c) => c.country).filter(Boolean))];
          await logActivity(wishlist.id, "BAND_ADDED", {
            band_name: band.name, band_id: band.band_id,
            inserted: fresh.length === all.length ? band.inserted : fresh.length, countries,
          });
        }
      }
      const unannounced = requestIds.filter((id) => !announced.has(id));
      if (unannounced.length > 0) {
        await prisma.concert.updateMany({
          where: { id: { in: unannounced }, announced_at: null },
          data: { announced_at: new Date() },
        });
      }

      // No longer owed to anyone, except where a post failed in a way worth
      // another go: those stay pending, and the next sync's /bulk hands them
      // back. Last, so a failure anywhere above leaves them pending too — the
      // deliveries on record keep the retry from posting anything twice.
      const settled = requestIds.filter((id) => !ledger.held.has(id));
      if (settled.length > 0) {
        await prisma.concert.updateMany({
          where: { id: { in: settled }, notify_pending: true },
          data: { notify_pending: false },
        });
      }

      res.json({ notified: notifications.length, subscription_notified: subscriptionNotified });
    } catch (error) {
      console.error("Error sending Discord notifications:", error);
      res.status(500).json({ error: "Failed to send notifications" });
    }
  },
);

/**
 * Posts to everyone whose NotificationSubscription rows match this batch.
 *
 * The concerts are re-read rather than taken from the payload: the scraper
 * sends city as the string it scraped, and a city watch is a City row. /bulk
 * has already resolved that mapping at insert, so reading the ids back is both
 * cheaper and more truthful than matching names here.
 *
 * @returns {Promise<number>} how many users were posted to
 */
async function notifySubscribers(bands, allWishlists, reportedByWishlist, ledger) {
  const concertIds = [
    ...new Set(
      bands
        .flatMap((b) => b.concerts ?? [])
        .map((c) => c.concert_id)
        .filter((id) => Number.isInteger(id)),
    ),
  ];
  // Scraper builds older than the concert_id field send nothing to match on.
  // The wishlist pass above still works, so this is a skip, not an error.
  if (concertIds.length === 0) return 0;

  const concerts = await prisma.concert.findMany({
    where: { id: { in: concertIds } },
    select: CONCERT_SELECT,
  });
  if (concerts.length === 0) return 0;

  const subscriptions = await prisma.notificationSubscription.findMany({
    include: { user_rel: { select: { id: true, email: true, settings: true } } },
  });
  if (subscriptions.length === 0) return 0;

  const webhookByUser = new Map(
    allWishlists.filter((w) => w.discord_webhook).map((w) => [w.user_id, w]),
  );
  // City-only watches only fire for bands the watcher follows. allWishlists is
  // already loaded with its band references, so this costs no extra query.
  const followed = followedBandsByUser(allWishlists);
  const settingsByUser = new Map(
    subscriptions.filter((s) => s.user_rel).map((s) => [s.user_rel.id, s.user_rel.settings]),
  );

  let notified = 0;
  await Promise.all(
    [...matchesByUser(concerts, subscriptions, followed)].map(async ([userId, { concerts: matched }]) => {
      const wishlist = webhookByUser.get(userId);
      if (!wishlist) return;

      const already = reportedByWishlist.get(wishlist.id) ?? new Set();
      const fresh = ledger.unsent(wishlist.id, matched.filter((c) => !already.has(c.id)));
      if (fresh.length === 0) return;

      const e = await ledger.send(wishlist.id, wishlist.discord_webhook, {
        title: "New concerts you're watching", concerts: fresh, content: mentionFor(settingsByUser.get(userId)),
      });
      if (e) {
        console.error(`[Discord] Failed to notify subscriber ${userId}:`, e.response?.status ?? e.message);
      } else {
        notified++;
      }
    }),
  );

  return notified;
}

module.exports = router;
