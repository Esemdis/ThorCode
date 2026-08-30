/**
 * The Discord webhook digest.
 *
 * Split out of routes/data/wishlists.js, which had grown to 1473 lines and
 * twenty-one endpoints. wishlists.js mounts this and its siblings in their
 * original declaration order — the manifest test in wishlists.test.js pins
 * the resulting surface.
 */
const express = require("express");
const router = express.Router();
const { validationResult, param, body } = require("express-validator");
const axios = require("axios");
const auth = require("../../../auth/verifyJWT");
const roleCheck = require("../../../middlewares/roleCheck");
const prisma = require("../../../prisma/client");

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

      await Promise.all(
        notifications.map(async ({ wishlist, matchedBands }) => {
          for (const band of matchedBands) {
            const embeds = buildDiscordEmbeds(band);
            for (const embed of embeds) {
              try {
                await axios.post(wishlist.discord_webhook, { embeds: [embed] }, { timeout: 10000 });
              } catch (e) {
                console.error(`[Discord] Failed to notify wishlist ${wishlist.id} for band "${band.name}":`, e.response?.status ?? e.message);
              }
            }
          }
        }),
      );

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

      res.json({ notified: notifications.length });
    } catch (error) {
      console.error("Error sending Discord notifications:", error);
      res.status(500).json({ error: "Failed to send notifications" });
    }
  },
);

function buildDiscordEmbeds(band) {
  const EMBED_CHAR_LIMIT = 5800;
  const FIELD_VALUE_LIMIT = 1024;
  const FIELD_NAME_LIMIT = 256;
  const MAX_FIELDS = 25;

  const fields = [];

  for (const concert of band.concerts ?? []) {
    const date = concert.concert_date
      ? new Date(concert.concert_date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
      : "TBA";
    const location = [concert.city, concert.country].filter(Boolean).join(", ");
    const venue = concert.venue || "Unknown venue";
    const rawLabel = `${date} — ${location}`;
    const label = rawLabel.length > FIELD_NAME_LIMIT ? rawLabel.slice(0, FIELD_NAME_LIMIT - 1) + "…" : rawLabel;
    const venueStr = concert.url ? `[${venue}](${concert.url})` : venue;

    let lineup = [];
    try { lineup = JSON.parse(concert.metadata || "[]"); } catch {}
    const fullLineup = lineup.length ? `\n${lineup.join(", ")}` : "";
    const maxLineup = FIELD_VALUE_LIMIT - venueStr.length - 1;
    const lineupStr = fullLineup.length > maxLineup ? fullLineup.slice(0, maxLineup) + "…" : fullLineup;

    fields.push({ name: label, value: venueStr + lineupStr, inline: false });
  }

  const title = `New concerts: ${band.name}`;
  const footer = `${fields.length} new concert${fields.length !== 1 ? "s" : ""}`;
  const baseChars = title.length + footer.length;

  const embeds = [];
  let current = [];
  let currentChars = baseChars;

  for (const field of fields) {
    const fieldChars = field.name.length + field.value.length;
    if (current.length > 0 && (currentChars + fieldChars > EMBED_CHAR_LIMIT || current.length >= MAX_FIELDS)) {
      embeds.push({ title, color: 0x5865f2, fields: current, footer: { text: footer } });
      current = [];
      currentChars = baseChars;
    }
    current.push(field);
    currentChars += fieldChars;
  }

  if (current.length > 0 || embeds.length === 0) {
    embeds.push({ title, color: 0x5865f2, fields: current, footer: { text: footer } });
  }

  return embeds;
}

module.exports = router;
