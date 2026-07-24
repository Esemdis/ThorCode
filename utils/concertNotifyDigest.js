const prisma = require("../prisma/client");
const { sendDigestEmail } = require("./mail");

// Which subscription kinds match a given concert:
// - band + city both set  -> that band, playing that exact city
// - band only             -> that band, any city
// - city only              -> any band, that exact city
function subscriptionMatches(sub, concert, bandIds) {
  if (sub.band_id != null && sub.city_id != null) {
    return bandIds.includes(sub.band_id) && concert.city_id === sub.city_id;
  }
  if (sub.band_id != null) return bandIds.includes(sub.band_id);
  if (sub.city_id != null) return concert.city_id === sub.city_id;
  return false;
}

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

  // user_id -> { email, items: Map(concertId -> concert summary) }
  const userMatches = new Map();

  for (const concert of concerts) {
    const bandIds = concert.bands.map((b) => b.band_rel.id);
    const bandNames = concert.bands.map((b) => b.band_rel.name);
    for (const sub of subscriptions) {
      if (!subscriptionMatches(sub, concert, bandIds)) continue;

      const uid = sub.user_rel.id;
      if (!userMatches.has(uid)) userMatches.set(uid, { email: sub.user_rel.email, items: new Map() });
      const bucket = userMatches.get(uid);
      if (!bucket.items.has(concert.id)) {
        bucket.items.set(concert.id, {
          name: concert.name,
          bandNames,
          venue: concert.venue,
          city: concert.city,
          country: concert.country,
          date: concert.concert_date,
          url: concert.url,
        });
      }
    }
  }

  let sent = 0;
  for (const [userId, { email, items }] of userMatches) {
    if (items.size === 0) continue;
    try {
      await sendDigestEmail({ to: email, items: [...items.values()] });
      sent++;
    } catch (err) {
      console.error(`[notifyDigest] Failed to send digest to user ${userId}:`, err.message);
    }
  }

  await prisma.notificationDigestRun.update({ where: { id: run.id }, data: { last_run_at: now } });
  return { sent, concerts: concerts.length };
}

module.exports = { runNotificationDigest };
