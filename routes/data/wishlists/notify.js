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
const { validationResult, param, body } = require("express-validator");
const axios = require("axios");
const auth = require("../../../auth/verifyJWT");
const roleCheck = require("../../../middlewares/roleCheck");
const prisma = require("../../../prisma/client");
const { matchesByUser } = require("../../../utils/notificationMatch");
const { buildDiscordEmbeds } = require("../../../utils/discordEmbeds");

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

async function postEmbeds(webhook, embeds, content) {
  for (const [i, embed] of embeds.entries()) {
    // The mention rides the first message only — one buzz per batch, not one
    // per embed, and a busy night can be several embeds.
    const payload = content && i === 0 ? { content, embeds: [embed] } : { embeds: [embed] };
    await axios.post(webhook, payload, { timeout: 10000 });
  }
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
            const embeds = buildDiscordEmbeds({
              title: `New concerts: ${band.name}`,
              concerts: band.concerts ?? [],
            });
            try {
              await postEmbeds(wishlist.discord_webhook, embeds);
            } catch (e) {
              console.error(`[Discord] Failed to notify wishlist ${wishlist.id} for band "${band.name}":`, e.response?.status ?? e.message);
            }
          }
        }),
      );

      const subscriptionNotified = await notifySubscribers(bands, allWishlists, reportedByWishlist);

      // Activity logs — all wishlists that have the band, only when concerts were inserted
      for (const wishlist of allWishlists) {
        const matchedBands = bands.filter(
          (b) => b.inserted > 0 && wishlist.bands.some((ref) => ref.band_rel.id === b.band_id),
        );
        for (const band of matchedBands) {
          const countries = [...new Set((band.concerts || []).map((c) => c.country).filter(Boolean))];
          await prisma.activityLog.create({
            data: {
              wishlist_id: wishlist.id,
              type: "BAND_ADDED",
              data: JSON.stringify({ band_name: band.name, band_id: band.band_id, inserted: band.inserted, countries }),
            },
          });
          const old = await prisma.activityLog.findMany({
            where: { wishlist_id: wishlist.id },
            orderBy: { created_at: "desc" },
            skip: 15,
            select: { id: true },
          });
          if (old.length > 0) {
            await prisma.activityLog.deleteMany({ where: { id: { in: old.map((e) => e.id) } } });
          }
        }
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
async function notifySubscribers(bands, allWishlists, reportedByWishlist) {
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
  const settingsByUser = new Map(
    subscriptions.filter((s) => s.user_rel).map((s) => [s.user_rel.id, s.user_rel.settings]),
  );

  let notified = 0;
  await Promise.all(
    [...matchesByUser(concerts, subscriptions)].map(async ([userId, { concerts: matched }]) => {
      const wishlist = webhookByUser.get(userId);
      if (!wishlist) return;

      const already = reportedByWishlist.get(wishlist.id) ?? new Set();
      const fresh = matched.filter((c) => !already.has(c.id));
      if (fresh.length === 0) return;

      const embeds = buildDiscordEmbeds({ title: "New concerts you're watching", concerts: fresh });
      try {
        await postEmbeds(wishlist.discord_webhook, embeds, mentionFor(settingsByUser.get(userId)));
        notified++;
      } catch (e) {
        console.error(`[Discord] Failed to notify subscriber ${userId}:`, e.response?.status ?? e.message);
      }
    }),
  );

  return notified;
}

module.exports = router;
