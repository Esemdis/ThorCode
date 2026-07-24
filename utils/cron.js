const cron = require("node-cron");
const { runNotificationDigest } = require("./concertNotifyDigest");

// Default: once a day at 08:00 server time.
const NOTIFICATION_DIGEST_CRON = process.env.NOTIFICATION_DIGEST_CRON || "0 8 * * *";

function startCronJobs() {
  cron.schedule(NOTIFICATION_DIGEST_CRON, async () => {
    try {
      const result = await runNotificationDigest();
      console.log(`[cron] Notification digest: sent to ${result.sent} user(s), ${result.concerts} new concert(s) scanned.`);
    } catch (err) {
      console.error("[cron] Notification digest failed:", err);
    }
  });
}

module.exports = { startCronJobs };
