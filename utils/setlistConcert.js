/**
 * The shared Concert row for one setlist.fm show, made or found from
 * setlist.fm's own record of it.
 *
 * Lifted out of POST /wishlists/:id/attendance/from-setlist (THO-823) because
 * moving an attendance to the right setlist.fm show needs the same row by the
 * same rules, and two copies of them would drift. Every fact about the show is
 * read from setlist.fm by id, never from the request: client-supplied show data
 * written into Concert, which every account reads, was a security hole (see
 * the route's own comment).
 *
 * Refusals are thrown as errors carrying `status`, so each route answers them
 * with its own response and the two cannot disagree about what is refused.
 */
const { storedCity } = require("./cityMatch");
const { venueId } = require("./venueMatch");
const { canonicalBandName } = require("./lineupNames");
// Called through the module rather than destructured, so a test can stand in
// for setlist.fm on this copy of it.
const setlistFm = require("./setlistFm");

// A show logged "today" can be dated tomorrow in UTC, and setlist.fm takes the
// venue's own date; a day of slack separates that from a show still to come.
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

// Marked, rather than recognised by `status` alone: an axios error carries a
// status of its own, and a 404 from some other call must not reach the client
// as if it were this one's answer.
const refusal = (status, message) => Object.assign(new Error(message), { status, setlistRefusal: true });

/**
 * @param {object} prisma
 * @param {{ setlistfmId: string, bandId: number }} args - setlistfmId already
 *   checked with setlistFm.isSetlistId
 * @returns {Promise<{ concert: { id: number }, show: object }>} show is
 *   setlistFm.setlistSummary of the setlist
 * @throws {Error & { status: number, setlistRefusal: true }} 404 band or setlist, 400 another
 *   artist's setlist or a show to come, 422 no date or venue, 502 setlist.fm
 *   unreachable, 503 not configured
 */
async function upsertSetlistConcert(prisma, { setlistfmId, bandId }) {
  const band = await prisma.band.findUnique({ where: { id: bandId }, select: { id: true, name: true, MBID: true } });
  if (!band) throw refusal(404, "Band not found");

  if (!process.env.SETLIST_API_KEY) {
    throw refusal(503, "Setlist.fm is not configured on this server");
  }

  let setlist;
  try {
    setlist = await setlistFm.fetchSetlistById(setlistfmId);
  } catch (error) {
    if (error.response?.status === 404) throw refusal(404, "Setlist not found on setlist.fm");
    console.error("[from-setlist] setlist.fm lookup failed:", error.response?.status ?? error.message);
    throw refusal(502, "Could not reach setlist.fm — try again shortly");
  }

  // The setlist has to be this band's. Quick-added bands often have no
  // MBID, so compare canonical names until setlist.fm can fill that gap.
  const artistMbid = setlist?.artist?.mbid ?? null;
  if (band.MBID && artistMbid) {
    if (band.MBID.toLowerCase() !== String(artistMbid).toLowerCase()) {
      throw refusal(400, "That setlist is by a different artist");
    }
  } else {
    const bandName = canonicalBandName(band.name);
    const artistName = canonicalBandName(setlist?.artist?.name);
    if (!bandName || !artistName || bandName !== artistName) {
      throw refusal(400, "That setlist is by a different artist");
    }

    // Remember setlist.fm's MBID after the name check, so later requests
    // can use the stronger identity check. Avoid claiming an MBID already
    // assigned to a different band.
    if (!band.MBID && artistMbid) {
      const mbidOwner = await prisma.band.findUnique({
        where: { MBID: String(artistMbid) },
        select: { id: true },
      });
      if (!mbidOwner || mbidOwner.id === band.id) {
        await prisma.band.updateMany({
          where: { id: band.id, MBID: null },
          data: { MBID: String(artistMbid) },
        });
      }
    }
  }

  const show = setlistFm.setlistSummary(setlist);
  const concertDate = setlistFm.setlistDate(show.date);
  if (!concertDate) throw refusal(422, "setlist.fm has no usable date for that show");
  // Attended means it happened. setlist.fm does list shows ahead of time.
  if (concertDate.getTime() > Date.now() + FUTURE_SLACK_MS) {
    throw refusal(400, "That show has not happened yet");
  }
  if (!show.venue || !show.city || !show.country) {
    throw refusal(422, "setlist.fm has no venue for that show");
  }

  const { venue, city, country, url } = show;
  const coord = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  const latitude = coord(show.latitude);
  const longitude = coord(show.longitude);
  const hasCoords = latitude != null && longitude != null;
  // Keyed on the id that was asked for and fetched, as it always was, so a
  // response that somehow lacked one cannot file every such show under
  // "sfm_null".
  const eventId = `sfm_${setlistfmId}`;

  // Coordinates and a city link, both of which this route used to leave
  // empty: a concert without a position is dropped by the map's grouping and
  // simply never appears, and the city link is what carries reachability.
  // A spelling of a place already stored nearby goes on that row.
  const cityName = (await storedCity(prisma, { name: city, country, latitude, longitude }))?.name ?? city;
  const cityRecord = await prisma.city.upsert({
    where: { name_country: { name: cityName, country } },
    create: {
      name: cityName,
      country,
      latitude: hasCoords ? latitude : null,
      longitude: hasCoords ? longitude : null,
    },
    update: {},
    select: { id: true, latitude: true },
  });
  const cityId = cityRecord.id;
  if (hasCoords && cityRecord.latitude == null) {
    await prisma.city.update({
      where: { id: cityRecord.id },
      data: { latitude, longitude },
    });
  }

  const concert = await prisma.concert.upsert({
    where: { event_id: eventId },
    create: {
      event_id: eventId,
      venue,
      city: cityName,
      country,
      concert_date: concertDate,
      on_sale: false,
      created_at: new Date(),
      url: url ?? null,
      source: "setlistfm",
      sources: ["setlistfm"],
      latitude: hasCoords ? String(latitude) : null,
      longitude: hasCoords ? String(longitude) : null,
      city_id: cityId,
      // No position: setlist.fm's is the city's (see below).
      venue_id: await venueId(prisma, { name: venue, cityId }),
    },
    update: {},
    select: { id: true },
  });

  // Gaps only, and never an overwrite. What setlist.fm returns is the
  // venue's *city* coordinates, so a row already placed at the venue itself
  // — by /bulk, or by the coordinate backfill — must keep what it has.
  if (hasCoords) {
    await prisma.concert.updateMany({
      where: { id: concert.id, OR: [{ latitude: null }, { longitude: null }] },
      data: { latitude: String(latitude), longitude: String(longitude) },
    });
  }
  await prisma.concert.updateMany({
    where: { id: concert.id, city_id: null },
    data: { city_id: cityId },
  });

  // Link band to concert with the setlist setlist.fm has for it.
  const setlistData = show.songs.length > 0 ? { songs: show.songs } : undefined;
  await prisma.concertBandReference.upsert({
    where: { concert_band: { concert: concert.id, band: bandId } },
    create: { concert: concert.id, band: bandId, setlist: setlistData },
    update: { ...(setlistData ? { setlist: setlistData } : {}) },
  });

  return { concert, show };
}

module.exports = { upsertSetlistConcert, FUTURE_SLACK_MS };
