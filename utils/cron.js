const cron = require("node-cron");
const { runNotificationDigest } = require("./concertNotifyDigest");
const { backfillSpotifyIds, warmBandImages } = require("./bandSpotifyMatch");
const { backfillSourceUrls } = require("./bandSourceUrlBackfill");
const { backfillSetlists } = require("./setlistBackfill");
const prisma = require("../prisma/client");

// Default: once a day at 08:00 server time.
const NOTIFICATION_DIGEST_CRON = process.env.NOTIFICATION_DIGEST_CRON || "0 8 * * *";

// Matches new bands to Spotify artists and refreshes every band's photo url.
// Daily is the required cadence, not a preference: the cached urls expire just
// under 24 hours (Spotify's cap), and the overview never fetches them itself.
// 04:00 keeps it off the digest's hour; 200 is well above the number of bands
// added in a day while still bounding a first run on a fresh database.
const SPOTIFY_BACKFILL_CRON = process.env.SPOTIFY_BACKFILL_CRON || "0 4 * * *";
const SPOTIFY_BACKFILL_LIMIT = 200;

// Re-tries Songkick/Bandsintown discovery for bands still missing one or
// both. Off the Spotify backfill's hour and rate-limited to MusicBrainz's own
// 1 req/sec, so 100 is a conservative per-run cap rather than a coverage
// target — most runs, once the backlog is cleared, touch far fewer bands.
const SOURCE_URL_BACKFILL_CRON = process.env.SOURCE_URL_BACKFILL_CRON || "0 5 * * *";
const SOURCE_URL_BACKFILL_LIMIT = 100;

// Re-tries Setlist.fm enrichment for attended shows still missing a setlist.
// Off the other backfills' hour. The common case is a show marked attended
// while still upcoming (Going and Attended are the same table, split by
// date), so the one attempt at attend time runs before Setlist.fm has
// anything — this is what actually catches it up once the show has happened.
const SETLIST_BACKFILL_CRON = process.env.SETLIST_BACKFILL_CRON || "0 6 * * *";
const SETLIST_BACKFILL_LIMIT = 50;

/**
 * Clean up expired email verification codes
 * Runs every hour
 */
async function cleanupExpiredEmailVerifications() {
  try {
    const deleted = await prisma.emailVerification.deleteMany({
      where: { expires_at: { lt: new Date() } },
    });
    if (deleted.count > 0) {
      console.log(`[cron] Cleaned up ${deleted.count} expired email verification code(s)`);
    }
  } catch (err) {
    console.error("[cron] Email verification cleanup failed:", err);
  }
}

function startCronJobs() {
  // Notification digest
  cron.schedule(NOTIFICATION_DIGEST_CRON, async () => {
    try {
      const result = await runNotificationDigest();
      console.log(`[cron] Notification digest: sent to ${result.sent} user(s), ${result.failed ?? 0} failed, ${result.concerts} new concert(s) scanned.`);
    } catch (err) {
      console.error("[cron] Notification digest failed:", err);
    }
  });

  // Cleanup expired email verifications - runs every hour
  cron.schedule("0 * * * *", cleanupExpiredEmailVerifications);

  // Give newly added bands their Spotify artist id, so the band overview has a
  // photo before anyone has opened them. Silent when there is nothing to do —
  // once the queue is empty this is a single count query.
  cron.schedule(SPOTIFY_BACKFILL_CRON, async () => {
    try {
      const { searched, matched, remaining } = await backfillSpotifyIds({ limit: SPOTIFY_BACKFILL_LIMIT });
      if (searched > 0) {
        console.log(`[cron] Spotify backfill: searched ${searched}, matched ${matched}, ${remaining} still unmatched.`);
      }

      // Warming runs after matching, in the same job, so a band added today has
      // both an id and a photo by morning. The band overview only reads the
      // cache, so this is the step that actually puts photos on the page.
      const { bands, withPhoto } = await warmBandImages();
      console.log(`[cron] Spotify images: warmed ${withPhoto} photo(s) for ${bands} matched band(s).`);
    } catch (err) {
      console.error("[cron] Spotify backfill failed:", err);
    }
  });

  // Give bands that MusicBrainz had nothing for another look. MB relationships
  // are added by volunteers, not the band, so a miss at creation time is not
  // permanent — this is what actually closes those gaps without an admin
  // manually clicking refresh on every band that came up empty.
  cron.schedule(SOURCE_URL_BACKFILL_CRON, async () => {
    try {
      const { checked, updated } = await backfillSourceUrls({ limit: SOURCE_URL_BACKFILL_LIMIT });
      if (checked > 0) {
        console.log(`[cron] Source URL backfill: checked ${checked}, updated ${updated}.`);
      }
    } catch (err) {
      console.error("[cron] Source URL backfill failed:", err);
    }
  });

  cron.schedule(SETLIST_BACKFILL_CRON, async () => {
    try {
      const { checked, updated } = await backfillSetlists({ limit: SETLIST_BACKFILL_LIMIT });
      if (checked > 0) {
        console.log(`[cron] Setlist backfill: checked ${checked}, updated ${updated}.`);
      }
    } catch (err) {
      console.error("[cron] Setlist backfill failed:", err);
    }
  });
}

module.exports = { startCronJobs };

