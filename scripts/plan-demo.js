/**
 * Plan a trip and print it, without a database.
 *
 *   ROUTE_PLANNER_URL=http://localhost:8000 node scripts/plan-demo.js [--transit]
 *
 * Exercises everything ThorCode contributes to day planning — building the
 * request from rows, calling the solver, reading the answer — against real
 * places, so the whole path can be checked before any of it is wired to
 * Postgres or to a UI. A plan is judged by reading it; assertions cannot tell
 * you a day is one nobody would actually follow.
 */

require("dotenv").config();

const { buildPlanRequest } = require("../utils/travel/planRequest");
const routePlanner = require("../utils/travel/routePlanner");
const { PLACES, START, END } = require("./fixtures/paris-places");

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

async function main() {
  const transit = process.argv.includes("--transit");

  // Stand-ins for rows that would have come out of Prisma. Ids are assigned the
  // way the database would, because days reference their hotel by id.
  const places = PLACES.map((p, i) => ({ id: i + 1, priority: 3, outdoor: false, ...p }));
  const trip = {
    start_date: new Date(`${START}T00:00:00Z`),
    end_date: new Date(`${END}T00:00:00Z`),
    // A wet Wednesday, so the outdoor nudge has something to do.
    weather_data: { days: [{ date: "2026-09-16", precip_avg: 6.4, weather_code: 61 }] },
  };

  const request = buildPlanRequest(trip, places, { transit, max_per_day: 8, time_limit_s: 10 });
  const names = new Map(places.map((p) => [p.id, p.name]));

  console.log(`${request.days.length} days, ${request.places.length} places, mode ${request.mode}` +
    `${transit ? " + transit" : ""}`);
  console.log(`solver: ${process.env.ROUTE_PLANNER_URL}\n`);

  const started = Date.now();
  const plan = await routePlanner.solve(request);
  console.log(`solved in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

  for (const day of plan.days) {
    const wet = request.days.find((d) => d.date === day.date)?.wet ? "  [rain]" : "";
    console.log(`\x1b[1m${day.date}${wet}\x1b[0m`);
    console.log(`  ${day.travel_minutes} min travelling, ${(day.walk_metres / 1000).toFixed(1)} km on foot`);
    day.stops.forEach((stop, i) => {
      const name = names.get(stop.place_id) ?? "?";
      const fills = stop.fills ? `  (${stop.fills})` : "";
      const by = stop.travel_mode === "transit" ? " by transit" : "";
      const leg = stop.travel_to ? `  +${stop.travel_to}min${by}` : "";
      if (i === 0) console.log(`  ${hhmm(stop.depart)}         leave ${name}`);
      else if (i === day.stops.length - 1) console.log(`  ${hhmm(stop.arrive)}         back at ${name}${leg}`);
      else console.log(`  ${hhmm(stop.arrive)}-${hhmm(stop.depart)}  ${name}${fills}${leg}`);
    });
    console.log("");
  }

  if (plan.dropped?.length) {
    console.log("\x1b[1mDidn't fit\x1b[0m");
    for (const d of plan.dropped) console.log(`  ${names.get(d.place_id) ?? "?"} — ${d.reason}`);
  }
  if (plan.unfilled_meals?.length) {
    console.log("\n\x1b[1mNo meal found\x1b[0m");
    for (const m of plan.unfilled_meals) console.log(`  ${m.date} ${m.meal}`);
  }
  if (plan.transit) {
    console.log(`\ntransit: ${plan.transit.legs} legs, timetable for ${plan.transit.queried_date}`);
  }
  if (plan.estimated) console.log("\n(times are straight-line estimates — OSRM was unreachable)");
}

main().catch((err) => {
  console.error(`\n${err.name}: ${err.message}`);
  if (!process.env.ROUTE_PLANNER_URL) {
    console.error("\nROUTE_PLANNER_URL is not set. Start route-planner and point at it:");
    console.error("  cd ../route-planner && .venv/bin/uvicorn main:app --port 8000");
    console.error("  ROUTE_PLANNER_URL=http://localhost:8000 node scripts/plan-demo.js");
  }
  process.exit(1);
});
