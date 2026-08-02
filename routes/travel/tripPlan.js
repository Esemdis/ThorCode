const express = require("express");
const router = express.Router({ mergeParams: true });

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const ownsTrip = require("../../middlewares/ownsTrip");
const prisma = require("../../prisma/client");
const { fail } = require("../../utils/apiResponse");
const { buildPlanRequest, PlanInputError } = require("../../utils/travel/planRequest");
const routePlanner = require("../../utils/travel/routePlanner");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));
router.use(ownsTrip);

/**
 * Whether the saved plan predates the last edit to the places it was built from.
 *
 * Computed rather than stored: a flag would have to be set by every write that
 * touches a place, which is exactly the kind of bookkeeping that gets forgotten
 * by the next route someone adds.
 */
function isStale(planUpdatedAt, places) {
  if (!planUpdatedAt) return false;
  return places.some((p) => p.updated_at > planUpdatedAt);
}

// GET /travel/trips/:tripId/plan — the last plan, if there is one
router.get("/", async (req, res) => {
  try {
    const [trip, places] = await Promise.all([
      prisma.trip.findUnique({
        where: { id: req.tripId },
        select: { plan_data: true, plan_updated_at: true },
      }),
      prisma.tripPlace.findMany({
        where: { trip_id: req.tripId },
        select: { updated_at: true },
      }),
    ]);

    res.json({
      data: trip?.plan_data ?? null,
      meta: {
        updated_at: trip?.plan_updated_at ?? null,
        stale: isStale(trip?.plan_updated_at, places),
        place_count: places.length,
      },
    });
  } catch (err) {
    fail(res, err, { context: `GET plan (trip ${req.tripId})` });
  }
});

// POST /travel/trips/:tripId/plan — solve and store
router.post("/", async (req, res) => {
  try {
    const [trip, places] = await Promise.all([
      prisma.trip.findUnique({
        where: { id: req.tripId },
        select: { start_date: true, end_date: true, weather_data: true },
      }),
      prisma.tripPlace.findMany({
        where: { trip_id: req.tripId },
        orderBy: [{ sort_order: "asc" }, { created_at: "asc" }],
      }),
    ]);

    // Thrown, not returned, because there is nothing partial to hand back: a
    // trip with no dates or no hotel has no plan to show, only a thing to fix.
    const request = buildPlanRequest(trip, places, req.body || {});
    const plan = await routePlanner.solve(request);

    const now = new Date();
    await prisma.trip.update({
      where: { id: req.tripId },
      data: { plan_data: plan, plan_updated_at: now },
    });

    res.json({ data: plan, meta: { updated_at: now, stale: false, place_count: places.length } });
  } catch (err) {
    // Both of these carry a message written to be read by whoever asked for the
    // plan — "add a hotel", "the planner is unavailable" — so they keep it.
    if (err instanceof PlanInputError || err instanceof routePlanner.RoutePlannerError) {
      return res.status(err.status).json({ error: err.message });
    }
    fail(res, err, { context: `POST plan (trip ${req.tripId})` });
  }
});

// POST /travel/trips/:tripId/plan/explain/:placeId — what would it take to fit
// this one in? Solves twice, so it is asked about one place and never a list.
router.post("/explain/:placeId", async (req, res) => {
  // Express hands parameters over as strings and the solver matches ids by
  // identity, so this conversion is the whole difference between an answer and
  // a confident "already in the plan" about a place that was left out.
  const placeId = Number(req.params.placeId);
  try {
    const [trip, places] = await Promise.all([
      prisma.trip.findUnique({
        where: { id: req.tripId },
        select: { start_date: true, end_date: true, weather_data: true },
      }),
      prisma.tripPlace.findMany({
        where: { trip_id: req.tripId },
        orderBy: [{ sort_order: "asc" }, { created_at: "asc" }],
      }),
    ]);

    if (!places.some((p) => p.id === placeId)) {
      return res.status(404).json({ error: "Place not found" });
    }

    // Built from the places as they are now, not from the saved plan. An
    // explanation of a plan whose places have since changed would be answering
    // a question nobody asked.
    const request = buildPlanRequest(trip, places, req.body || {});
    res.json({ data: await routePlanner.explain(request, placeId) });
  } catch (err) {
    if (err instanceof PlanInputError || err instanceof routePlanner.RoutePlannerError) {
      return res.status(err.status).json({ error: err.message });
    }
    fail(res, err, { context: `POST plan explain (trip ${req.tripId}, place ${placeId})` });
  }
});

// DELETE /travel/trips/:tripId/plan — throw the plan away, keep the places
router.delete("/", async (req, res) => {
  try {
    await prisma.trip.update({
      where: { id: req.tripId },
      data: { plan_data: null, plan_updated_at: null },
    });
    res.json({ message: "Plan cleared" });
  } catch (err) {
    fail(res, err, { context: `DELETE plan (trip ${req.tripId})` });
  }
});

module.exports = router;
