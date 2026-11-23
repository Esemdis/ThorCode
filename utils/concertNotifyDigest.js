const prisma = require("../prisma/client");
// Through the module rather than destructured, so a test can stand in for
// Resend on this file's own copy of it.
const mail = require("./mail");
// Shared with POST /wishlists/notify, which posts the same matches to Discord
// the moment the scraper reports them. See notificationMatch.js for why the
// rule cannot live in either caller.
const { matchesByUser, followedBandsByUser } = require("./notificationMatch");
// The whole bill, Band rows and scraped names alike: on a festival most of what
// is already announced has no row at all, and the email is where you read what
// the acts that just joined are joining.
const { billForConcert } = require("./concertBill");

// Scans the acts put on a bill since the last run, matches them against all
// NotificationSubscription rows, and sends one digest email per affected user.
//
// Acts rather than concerts: a festival is one row that gains its acts over
// months, and reading rows by created_at told a watcher about the first act
// and never the rest. A new show's acts are all put on its bill as it is
// created, so one rule covers both.
async function runNotificationDigest() {
  const now = new Date();

  // Oldest row first, so every process reads the same cursor even if a race
  // on an empty table ever left two.
  let run = await prisma.notificationDigestRun.findFirst({ orderBy: { id: "asc" } });
  if (!run) run = await prisma.notificationDigestRun.create({ data: { last_run_at: new Date(0) } });
  const since = run.last_run_at;

  // Claim the window before reading or sending anything (THO-974). dev and prd
  // share one database, and a workstation running this job at 09:00 beside the
  // container meant both read the same cursor and both sent the same digest.
  // The write only lands if the cursor still says what this run read, so of
  // two runs exactly one gets count 1 and the other stops here. A crash after
  // the claim loses this window's digests rather than sending them twice: the
  // same trade the partial-failure rule below already makes.
  const claim = await prisma.notificationDigestRun.updateMany({
    where: { id: run.id, last_run_at: since },
    data: { last_run_at: now },
  });
  if (claim.count === 0) {
    console.log(`[notifyDigest] The window from ${since.toISOString()} was already taken by another run; sending nothing.`);
    return { sent: 0, concerts: 0, failed: 0, skipped: true };
  }

  // Created in the window is not the same as announced in it: a show imported
  // from setlist.fm history is created today with a date years back, and it
  // went out as a new concert. Still to come by calendar day, or not dated yet
  // — the email prints that one as "Date TBA".
  const startOfToday = new Date(now);
  startOfToday.setUTCHours(0, 0, 0, 0);

  const links = await prisma.concertBandReference.findMany({
    where: {
      created_at: { gt: since, lte: now },
      concert_rel: {
        OR: [{ concert_date: null }, { concert_date: { gte: startOfToday } }],
      },
    },
    select: {
      band_rel: { select: { id: true, name: true } },
      concert_rel: {
        select: {
          id: true,
          name: true,
          venue: true,
          city: true,
          country: true,
          concert_date: true,
          url: true,
          city_id: true,
          created_at: true,
          // The scraped lineup, which is the rest of the bill.
          metadata: true,
          bands: { select: { band_rel: { select: { id: true, name: true } } } },
        },
      },
    },
  });

  // One entry per show. `bands` is what the matcher reads, so it holds only
  // the acts that are news; the whole bill rides along for the email.
  const byConcert = new Map();
  for (const { band_rel, concert_rel } of links) {
    if (!byConcert.has(concert_rel.id)) {
      const { bands: bill, created_at, ...concert } = concert_rel;
      byConcert.set(concert_rel.id, { ...concert, bill, added: created_at <= since, bands: [] });
    }
    byConcert.get(concert_rel.id).bands.push({ band_rel });
  }
  const concerts = [...byConcert.values()];

  // Nothing new: the claim has already moved the window on.
  if (concerts.length === 0) return { sent: 0, concerts: 0 };

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
  let attempted = 0;
  for (const [userId, { email, concerts: matched }] of byUser) {
    if (!email || matched.length === 0) continue;
    const mine = followed.get(userId);
    const items = matched.map((c) => ({
      name: c.name,
      // Everyone on the bill, so an act joining a festival is read against the
      // acts already on it rather than on its own.
      bandNames: billForConcert({ bands: c.bill.map((ref) => ref.band_rel), metadata: c.metadata }).map((act) => act.name),
      // On a show the email has been about before, which acts are the news.
      newBandNames: c.added ? c.bands.map((b) => b.band_rel.name) : null,
      // Which of them this watcher follows — marked in the email, because on a
      // forty-act bill that is the thing being looked for. Only the acts with a
      // Band row can be on a wishlist, which is exactly what `bill` holds.
      yourBandNames: mine ? c.bill.filter((b) => mine.has(b.band_rel.id)).map((b) => b.band_rel.name) : [],
      venue: c.venue,
      city: c.city,
      country: c.country,
      date: c.concert_date,
      url: c.url,
    }));
    attempted++;
    try {
      await mail.sendDigestEmail({ to: email, items });
      sent++;
    } catch (err) {
      console.error(`[notifyDigest] Failed to send digest to user ${userId}:`, err.message);
    }
  }

  // When nothing went out at all — a bad key, an unverified sender, the
  // email service down — the window goes back to where it was, so the next run
  // sends these concerts instead of skipping past them. Only while the cursor
  // still holds this run's claim: a run that took the window since must not be
  // undone. A partial failure keeps the claim and moves on: those that did
  // send must not be sent again, and there is no record of who is owed what.
  if (attempted > 0 && sent === 0) {
    await prisma.notificationDigestRun.updateMany({
      where: { id: run.id, last_run_at: now },
      data: { last_run_at: since },
    });
    console.error(`[notifyDigest] No digest could be sent (${attempted} tried); keeping the window from ${since.toISOString()} for the next run.`);
    return { sent, concerts: concerts.length, failed: attempted };
  }

  return { sent, concerts: concerts.length, failed: attempted - sent };
}

module.exports = { runNotificationDigest };
