const prisma = require("../prisma/client");
const { sendDigestEmail } = require("./mail");
// Shared with POST /wishlists/notify, which posts the same matches to Discord
// the moment the scraper reports them. See notificationMatch.js for why the
// rule cannot live in either caller.
const { matchesByUser, followedBandsByUser } = require("./notificationMatch");

// Scans concerts created since the last run, matches them against all
// NotificationSubscription rows, and sends one digest email per affected user.
async function runNotificationDigest() {
  const now = new Date();

  let run = await prisma.notificationDigestRun.findFirst();
  if (!run) run = await prisma.notificationDigestRun.create({ data: { last_run_at: new Date(0) } });
  const since = run.last_run_at;

  const concerts = await prisma.concert.findMany({
    where: { created_at: { gt: since, lte: now }, city_id: { not: null } },
    select: {
      id: true,
      name: true,
      venue: true,
      city: true,
      country: true,
      concert_date: true,
      url: true,
      city_id: true,
      bands: { select: { band_rel: { select: { id: true, name: true } } } },
    },
  });

  if (concerts.length === 0) {
    await prisma.notificationDigestRun.update({ where: { id: run.id }, data: { last_run_at: now } });
    return { sent: 0, concerts: 0 };
  }

  const subscriptions = await prisma.notificationSubscription.findMany({
    include: { user_rel: { select: { id: true, email: true } } },
  });

  // A city-only watch is scoped to the subscriber's own wishlist, so the
  // matcher needs each watcher's followed bands. Only users who actually hold a
  // subscription are read — on a database where most accounts never set one up,
  // that is a much smaller query than every wishlist.
  const watcherIds = [...new Set(subscriptions.map((s) => s.user_id))];
  const wishlists = await prisma.wishlist.findMany({
    where: { user_id: { in: watcherIds } },
    select: { user_id: true, bands: { select: { band_id: true } } },
  });
  const followed = followedBandsByUser(wishlists);

  // Grouping is matchesByUser's job rather than a second loop here. This used
  // to be an inline copy of it, which is exactly the drift notificationMatch.js
  // warns about — the Discord path would have gained wishlist scoping and the
  // email path silently kept the old wildcard.
  const byUser = matchesByUser(concerts, subscriptions, followed);

  let sent = 0;
  for (const [userId, { email, concerts: matched }] of byUser) {
    if (!email || matched.length === 0) continue;
    const items = matched.map((c) => ({
      name: c.name,
      bandNames: c.bands.map((b) => b.band_rel.name),
      venue: c.venue,
      city: c.city,
      country: c.country,
      date: c.concert_date,
      url: c.url,
    }));
    try {
      await sendDigestEmail({ to: email, items });
      sent++;
    } catch (err) {
      console.error(`[notifyDigest] Failed to send digest to user ${userId}:`, err.message);
    }
  }

  await prisma.notificationDigestRun.update({ where: { id: run.id }, data: { last_run_at: now } });
  return { sent, concerts: concerts.length };
}

module.exports = { runNotificationDigest };
