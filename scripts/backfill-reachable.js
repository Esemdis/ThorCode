/**
 * Recompute reachability for all concerts and cities using the current logic:
 * a city is reachable if it is within 50km of a national capital or top-5
 * most-populous city in its country.
 *
 * Run from ThorCode/: doppler run -- node scripts/backfill-reachable.js
 *
 * Requires python/services/major_cities.json.
 * Generate it first if missing:
 *   python3 ../python/scripts/fetch_major_cities.py
 */
const prisma = require('../prisma/client');
const fs = require('fs');
const path = require('path');

const SERVICES = path.join(__dirname, '../../python/services');
const majorCitiesPath = path.join(SERVICES, 'major_cities.json');

if (!fs.existsSync(majorCitiesPath)) {
  console.error('✗ major_cities.json not found.');
  console.error('  Run: python3 ../python/scripts/fetch_major_cities.py');
  process.exit(1);
}

const majorCities = JSON.parse(fs.readFileSync(majorCitiesPath, 'utf8'));
console.log(`Loaded ${majorCities.length} major cities.`);

const MAX_MAJOR_CITY_KM = 50;

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dlat = ((lat2 - lat1) * Math.PI) / 180;
  const dlng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dlat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dlng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function computeReachable(lat, lng) {
  const la = parseFloat(lat);
  const lo = parseFloat(lng);
  if (isNaN(la) || isNaN(lo)) return 'false';
  return majorCities.some((c) => haversine(la, lo, c.lat, c.lng) <= MAX_MAJOR_CITY_KM)
    ? 'true'
    : 'false';
}

async function main() {
  // --- Concerts ---
  const concerts = await prisma.concert.findMany({
    where: { latitude: { not: null }, longitude: { not: null } },
    select: { id: true, latitude: true, longitude: true, city: true },
  });

  console.log(`\nRecomputing reachability for ${concerts.length} concert(s)...`);
  let cTrue = 0, cFalse = 0;

  for (const c of concerts) {
    const reachable = computeReachable(c.latitude, c.longitude);
    await prisma.concert.update({ where: { id: c.id }, data: { reachable } });
    if (reachable === 'true') cTrue++; else cFalse++;
  }

  console.log(`Concerts — reachable=true: ${cTrue}, reachable=false: ${cFalse}`);

  // --- Cities ---
  const cities = await prisma.city.findMany({
    where: { latitude: { not: null }, longitude: { not: null } },
    select: { id: true, latitude: true, longitude: true, name: true },
  });

  console.log(`\nRecomputing reachability for ${cities.length} city record(s)...`);
  let cityTrue = 0, cityFalse = 0;

  for (const c of cities) {
    const reachable = computeReachable(c.latitude, c.longitude);
    await prisma.city.update({ where: { id: c.id }, data: { reachable } });
    if (reachable === 'true') cityTrue++; else cityFalse++;
  }

  console.log(`Cities — reachable=true: ${cityTrue}, reachable=false: ${cityFalse}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
