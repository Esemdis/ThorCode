/**
 * The shared Concert row for a setlist.fm show, read from setlist.fm by id.
 *
 * Lifted out of POST /wishlists/:id/attendance/from-setlist so that moving an
 * attendance to another setlist (THO-823) resolves its target by exactly the
 * same rules. Two copies would drift, and the rules are the security boundary:
 * nothing the client says about a show is written into Concert, the table
 * every account reads — only which setlist and which band.
 */
const { storedCity } = require("./cityMatch");
const { venueId } = require("./venueMatch");
const { canonicalBandName } = require("./lineupNames");
// Called through the module rather than destructured, so a test can stand in
// for setlist.fm on the shared CommonJS copy of it.
const setlistFm = require("./setlistFm");

// A show logged "today" can be dated tomorrow in UTC, and setlist.fm takes the
// venue's own date; a day of slack separates that from a show still to come.
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

/** An error the route answers with as `{ error: message }` at `status`. */
class SetlistConcertError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Find or create the `sfm_<setlistfmId>` concert, linked to the band with the
 * setlist setlist.fm has for it.
 *
 * @param {object} prisma
 * @param {{ setlistfmId: string, bandId: number }} args
 * @returns {Promise<{ concert: { id: number }, show: object }>}
 * @throws {SetlistConcertError} 404, 400, 422, 502 or 503, with the sentence to send
 */
async function upsertSetlistConcert(prisma, { setlistfmId, bandId }) {
  const band = await prisma.band.findUnique({ where: { id: bandId }, select: { id: true, name: true, MBID: true } });
  if (!band) throw new SetlistConcertError(404, "Band not found");

  if (!process.env.SETLIST_API_KEY) {
    throw new SetlistConcertError(503, "Setlist.fm is not configured on this server");
  }

  let setlist;
  try {
    setlist = await setlistFm.fetchSetlistById(setlistfmId);
  } catch (error) {
    if (error.response?.status === 404) throw new SetlistConcertError(404, "Setlist not found on setlist.fm");
    console.error("[from-setlist] setlist.fm lookup failed:", error.response?.status ?? error.message);
    throw new SetlistConcertError(502, "Could not reach setlist.fm — try again shortly");
  }

  // The setlist has to be this band's. Quick-added bands often have no
  // MBID, so compare canonical names until setlist.fm can fill that gap.
  const artistMbid = setlist?.artist?.mbid ?? null;
  if (band.MBID && artistMbid) {
    if (band.MBID.toLowerCase() !== String(artistMbid).toLowerCase()) {
      throw new SetlistConcertError(400, "That setlist is by a different artist");
    }
  } else {
    const bandName = canonicalBandName(band.name);
    const artistName = canonicalBandName(setlist?.artist?.name);
    if (!bandName || !artistName || bandName !== artistName) {
      throw new SetlistConcertError(400, "That setlist is by a different artist");
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
  if (!concertDate) throw new SetlistConcertError(422, "setlist.fm has no usable date for that show");
  // Attended means it happened. setlist.fm does list shows ahead of time.
  if (concertDate.getTime() > Date.now() + FUTURE_SLACK_MS) {
    throw new SetlistConcertError(400, "That show has not happened yet");
  }
  if (!show.venue || !show.city || !show.country) {
    throw new SetlistConcertError(422, "setlist.fm has no venue for that show");
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

module.exports = { upsertSetlistConcert, SetlistConcertError };
