/**
 * Create a trip full of places, so the HTTP endpoints have something to plan.
 *
 *   doppler run -- node scripts/seed-trip-places.js <email> [--replace]
 *
 * scripts/plan-demo.js checks the same path without a database; this one exists
 * for testing the routes themselves — ownership, validation, storing the plan —
 * which needs real rows belonging to a real user.
 *
 * `--replace` deletes any trip this script made for that user first, so it can
 * be run repeatedly without collecting demo trips.
 */

require("dotenv").config();

const jwt = require("jsonwebtoken");
const prisma = require("../prisma/client");
const { PLACES, START, END } = require("./fixtures/paris-places");

const TRIP_NAME = "Paris (route planner demo)";

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: doppler run -- node scripts/seed-trip-places.js <email> [--replace]");
    process.exit(1);
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, role: true },
  });
  if (!user) {
    console.error(`No user found with email: ${email}`);
    process.exit(1);
  }

  if (process.argv.includes("--replace")) {
    // Places and the plan go with the trip: TripPlace cascades on delete and
    // plan_data is a column on Trip.
    const { count } = await prisma.trip.deleteMany({ where: { user_id: user.id, name: TRIP_NAME } });
    if (count) console.log(`Removed ${count} previous demo trip(s)`);
  }

  const trip = await prisma.trip.create({
    data: {
      user_id: user.id,
      name: TRIP_NAME,
      destination: "Paris, France",
      start_date: new Date(`${START}T00:00:00Z`),
      end_date: new Date(`${END}T00:00:00Z`),
      // A wet Wednesday, so the outdoor nudge has something to push against
      // without waiting for the real forecast sync to run.
      weather_data: { location: "Paris", days: [{ date: "2026-09-16", precip_avg: 6.4, weather_code: 61 }] },
      weather_updated_at: new Date(),
      places: {
        create: PLACES.map((p, i) => ({
          name: p.name,
          kind: p.kind,
          lat: p.lat,
          lon: p.lon,
          duration: p.duration ?? null,
          priority: p.priority ?? 3,
          outdoor: p.outdoor ?? false,
          hours: p.hours ?? null,
          sort_order: i,
        })),
      },
    },
    include: { places: { select: { id: true } } },
  });

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  console.log(`\nTrip ${trip.id} — "${trip.name}", ${trip.places.length} places, ${START} to ${END}\n`);
  console.log("Try it:\n");
  console.log(`  export T=${token}`);
  console.log(`  export API=http://localhost:4000\n`);
  console.log(`  curl -s $API/travel/trips/${trip.id}/places -H "Authorization: Bearer $T" | jq '.data | length'`);
  console.log(`  curl -s -X POST $API/travel/trips/${trip.id}/plan -H "Authorization: Bearer $T" \\`);
  console.log(`       -H 'Content-Type: application/json' -d '{"transit":true}' | jq '.data.days[0]'`);
  console.log(`  curl -s $API/travel/trips/${trip.id}/plan -H "Authorization: Bearer $T" | jq '.meta'\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
