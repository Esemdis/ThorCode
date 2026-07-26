const prisma = require("../prisma/client");
const { fail } = require("../utils/apiResponse");

// Resolves :tripId once for a whole sub-router. Every route under
// /travel/trips/:tripId/* needs the same two things — that the id is a number,
// and that the trip belongs to the caller — and each one used to ask the
// database separately. Asking here means one query per request instead of one
// per handler, and no new route can forget to ask.
//
// Handlers read req.tripId, which is a validated integer by the time they run.
module.exports = async function ownsTrip(req, res, next) {
  const tripId = parseInt(req.params.tripId, 10);
  if (!Number.isInteger(tripId)) {
    return res.status(400).json({ error: "Invalid tripId" });
  }

  try {
    const trip = await prisma.trip.findFirst({
      where: { id: tripId, user_id: req.user.id },
      select: { id: true },
    });
    if (!trip) return res.status(404).json({ error: "Trip not found" });

    req.tripId = tripId;
    return next();
  } catch (err) {
    return fail(res, err, { context: `ownsTrip ${tripId}` });
  }
};
