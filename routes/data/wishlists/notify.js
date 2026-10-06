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
 *
 * What is news is an act put on a show's bill: every act on a show just found,
 * and an act joining a show already known. The second is how a festival fills
 * up — one row, its acts linked to it a scrape at a time — and when only new
 * rows were news, every act after a festival's first reached no one. The
 * scraper says which shows to look at; which of their acts are news is read
 * from the links /bulk flagged.
 */
const express = require("express");
const router = express.Router();
const { validationResult, body } = require("express-validator");
const axios = require("axios");
const auth = require("../../../auth/verifyJWT");
const roleCheck = require("../../../middlewares/roleCheck");
const prisma = require("../../../prisma/client");
const { subscriptionMatches, followedBandsByUser } = require("../../../utils/notificationMatch");
const { buildDiscordEmbeds } = require("../../../utils/discordEmbeds");
const { logActivity } = require("./shared");

// The concert row both passes post, and the subscription pass matches against.
// Read back rather than taken from the payload: the scraper sends city as the
// string it scraped, and a city watch is a City row /bulk resolved at insert.
// The links say which acts are news.
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
  bands: { select: { id: true, notify_pending: true, band_rel: { select: { id: true, name: true } } } },
};

/**
 * The shows in this request with an act still owed its announcement.
 *
 * `added` marks a show some of whose bill was there before, so the post can say
 * which acts are the new ones rather than presenting a known festival as new.
 *
 * @returns {Promise<Array<{concert: object, acts: {id: number, name: string}[], linkIds: number[], added: boolean}>>}
 */
async function readNews(concertIds) {
  if (concertIds.length === 0) return [];
  const concerts = await prisma.concert.findMany({
    where: { id: { in: concertIds } },
    select: CONCERT_SELECT,
  });
  return concerts.flatMap((concert) => {
    const pending = (concert.bands ?? []).filter((ref) => ref.notify_pending);
    if (pending.length === 0) return [];
    return [{
      concert,
      acts: pending.map((ref) => ref.band_rel),
      linkIds: pending.map((ref) => ref.id),
      added: pending.length < concert.bands.length,
    }];
  });
}

// One field in a post: the show, the acts this post is telling its recipient
// about (which is what gets recorded as delivered), and, when the show was
// already known, their names to print.
const entry = (item, acts) => ({
  ...item.concert,
  acts,
  new_acts: item.added ? acts.map((a) => a.name) : null,
});

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

// A show and one act on it, the unit a delivery is recorded in.
const actKey = (concertId, bandId) => `${concertId}:${bandId}`;

/**
 * Who has been told about which act on which show, and which shows are still
 * owed to someone.
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
        select: { concert_id: true, wishlist_id: true, band_id: true },
      })
    : [];
  const had = new Set(rows.map((r) => `${actKey(r.concert_id, r.band_id)}:${r.wishlist_id}`));
  const held = new Set();

  return {
    held,
    /** The acts on this show this wishlist has not been told about yet. */
    unsent: (wishlistId, concertId, acts) => acts.filter((a) => !had.has(`${actKey(concertId, a.id)}:${wishlistId}`)),
    /** Posts them, records what arrived, and holds what failed for a retry. */
    async send(wishlistId, webhook, post) {
      const { delivered, undelivered, error } = await postConcerts(webhook, post);
      const arrived = delivered
        .filter((c) => Number.isInteger(c.id))
        .flatMap((c) => (c.acts ?? []).map((a) => ({ concert_id: c.id, band_id: a.id })));
      if (arrived.length) {
        await prisma.concertDelivery.createMany({
          data: arrived.map((d) => ({ ...d, wishlist_id: wishlistId })),
          skipDuplicates: true,
        });
        for (const d of arrived) had.add(`${actKey(d.concert_id, d.band_id)}:${wishlistId}`);
      }
      if (error && !failedForGood(error)) {
        for (const c of undelivered) if (Number.isInteger(c.id)) held.add(c.id);
      }
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

// "New concerts: Ghost, Opeth", short enough for Discord's 256-character title.
function titleFor(names) {
  const list = [...new Set(names)].join(", ");
  return `New concerts: ${list.length > 200 ? `${list.slice(0, 199)}…` : list}`;
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
      const news = await readNews(requestIds);
      const ledger = await deliveryLedger(requestIds);

      // All wishlists — needed for activity logs regardless of webhook
      const allWishlists = await prisma.wishlist.findMany({
        include: {
          bands: {
            include: { band_rel: { select: { id: true, name: true, ticketmaster_id: true } } },
          },
        },
      });

      // Shows from scraper builds older than concert_id, which cannot be read
      // back: posted under the band whose scrape found them, as they always were.
      const legacyFor = (follows) => bands
        .filter((b) => follows.has(b.band_id))
        .map((b) => ({ name: b.name, concerts: (b.concerts ?? []).filter((c) => !Number.isInteger(c.concert_id)) }))
        .filter((b) => b.concerts.length > 0);

      // What each wishlist follows that this request has news of.
      const followedNews = (wishlist) => {
        const follows = new Set(wishlist.bands.map((ref) => ref.band_rel.id));
        const items = news
          .map((item) => ({ item, acts: item.acts.filter((a) => follows.has(a.id)) }))
          .filter(({ acts }) => acts.length > 0);
        return { items, legacy: legacyFor(follows) };
      };

      const noWebhookCount = allWishlists.filter((w) => {
        if (w.discord_webhook) return false;
        const { items, legacy } = followedNews(w);
        return items.length > 0 || legacy.length > 0;
      }).length;
      if (noWebhookCount > 0) {
        console.log(`[Discord] ${noWebhookCount} wishlist(s) matched but have no webhook configured — skipping`);
      }

      // The acts the wishlist pass told each wishlist about, so the
      // subscription pass below does not repeat them. Subscribing to a band
      // that is also on your wishlist is the ordinary case, not an edge one.
      const reportedByWishlist = new Map();
      let notified = 0;

      await Promise.all(
        allWishlists.filter((w) => w.discord_webhook).map(async (wishlist) => {
          const { items, legacy } = followedNews(wishlist);
          const reported = new Set();
          reportedByWishlist.set(wishlist.id, reported);

          // One post for everything this wishlist follows, rather than one per
          // act: a festival announced with five of your bands is one show.
          const concerts = [];
          for (const { item, acts } of items) {
            for (const a of acts) reported.add(actKey(item.concert.id, a.id));
            // A retried show goes only to the wishlists that did not get it.
            const unsent = ledger.unsent(wishlist.id, item.concert.id, acts);
            if (unsent.length > 0) concerts.push(entry(item, unsent));
          }
          for (const band of legacy) concerts.push(...band.concerts);
          if (concerts.length === 0) return;

          notified++;
          const names = [...concerts.flatMap((c) => (c.acts ?? []).map((a) => a.name)), ...legacy.map((b) => b.name)];
          const e = await ledger.send(wishlist.id, wishlist.discord_webhook, { title: titleFor(names), concerts });
          if (e) {
            console.error(`[Discord] Failed to notify wishlist ${wishlist.id}:`, e.response?.status ?? e.message);
          }
        }),
      );

      const subscriptionNotified = await notifySubscribers(news, allWishlists, reportedByWishlist, ledger);

      // Activity logs — all wishlists that have the band, only when concerts
      // were inserted. A show whose post failed somewhere comes back on the
      // next sync, and the feeds already have it: only the shows they have
      // not been told about are logged.
      //
      // An act joining a known show is not a new show, and the batch it rides
      // in can be another act's: logged here, it would read as a new concert
      // for whichever band the scraper filed it under.
      const announced = new Set([
        ...news.filter((item) => item.added).map((item) => item.concert.id),
        ...(requestIds.length
          ? (await prisma.concert.findMany({
              where: { id: { in: requestIds }, announced_at: { not: null } },
              select: { id: true, announced_at: true },
            })).filter((c) => c.announced_at != null).map((c) => c.id)
          : []),
      ]);
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
      //
      // The links are cleared by id, the ones read above: an act linked since
      // is still owed, and stays flagged for the next run.
      const settled = requestIds.filter((id) => !ledger.held.has(id));
      if (settled.length > 0) {
        const settledSet = new Set(settled);
        const settledLinks = news.filter((item) => settledSet.has(item.concert.id)).flatMap((item) => item.linkIds);
        if (settledLinks.length > 0) {
          await prisma.concertBandReference.updateMany({
            where: { id: { in: settledLinks } },
            data: { notify_pending: false },
          });
        }
        await prisma.concert.updateMany({
          where: { id: { in: settled }, notify_pending: true },
          data: { notify_pending: false },
        });
      }

      res.json({ notified, subscription_notified: subscriptionNotified });
    } catch (error) {
      console.error("Error sending Discord notifications:", error);
      res.status(500).json({ error: "Failed to send notifications" });
    }
  },
);

/**
 * Posts to everyone whose NotificationSubscription rows match this request's
 * news.
 *
 * Matched per user against only what that user has not been told about yet,
 * in this request or before. Otherwise a city watch would fire on a show
 * because of an act the wishlist pass had just posted, and then post the
 * show again for some other act on it the watch has nothing to do with.
 *
 * @returns {Promise<number>} how many users were posted to
 */
async function notifySubscribers(news, allWishlists, reportedByWishlist, ledger) {
  // Scraper builds older than the concert_id field send nothing to match on.
  // The wishlist pass above still works, so this is a skip, not an error.
  if (news.length === 0) return 0;

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
  const subsByUser = new Map();
  for (const sub of subscriptions) {
    const uid = sub.user_rel?.id ?? sub.user_id;
    if (!subsByUser.has(uid)) subsByUser.set(uid, []);
    subsByUser.get(uid).push(sub);
  }

  let notified = 0;
  await Promise.all(
    [...subsByUser].map(async ([userId, subs]) => {
      const wishlist = webhookByUser.get(userId);
      if (!wishlist) return;

      const already = reportedByWishlist.get(wishlist.id) ?? new Set();
      const concerts = [];
      for (const item of news) {
        const fresh = ledger
          .unsent(wishlist.id, item.concert.id, item.acts)
          .filter((a) => !already.has(actKey(item.concert.id, a.id)));
        if (fresh.length === 0) continue;
        const ids = fresh.map((a) => a.id);
        if (subs.some((sub) => subscriptionMatches(sub, item.concert, ids, followed.get(userId)))) {
          concerts.push(entry(item, fresh));
        }
      }
      if (concerts.length === 0) return;

      const e = await ledger.send(wishlist.id, wishlist.discord_webhook, {
        title: "New concerts you're watching", concerts, content: mentionFor(subs[0].user_rel?.settings),
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
