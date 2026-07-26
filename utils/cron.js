const cron = require("node-cron");
const { runNotificationDigest } = require("./concertNotifyDigest");
const prisma = require("../prisma/client");

// Default: once a day at 08:00 server time.
const NOTIFICATION_DIGEST_CRON = process.env.NOTIFICATION_DIGEST_CRON || "0 8 * * *";

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
      console.log(`[cron] Notification digest: sent to ${result.sent} user(s), ${result.concerts} new concert(s) scanned.`);
    } catch (err) {
      console.error("[cron] Notification digest failed:", err);
    }
  });

  // Cleanup expired email verifications - runs every hour
  cron.schedule("0 * * * *", cleanupExpiredEmailVerifications);
}

module.exports = { startCronJobs };

