const prisma = require('../prisma/client');
const axios = require('axios');

const DELAY_MS = 1100; // MusicBrainz rate limit: 1 req/sec

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchMBID(bandName) {
  const response = await axios.get('https://musicbrainz.org/ws/2/artist/', {
    params: { query: `artist:"${bandName}"`, limit: 1, fmt: 'json' },
    headers: {
      'User-Agent': `${process.env.APP_NAME}/${process.env.APP_VERSION} (${process.env.APP_CONTACT})`,
    },
  });
  return response.data?.artists?.[0]?.id ?? null;
}

async function main() {
  require('dotenv').config();

  const bands = await prisma.band.findMany({
    where: { MBID: null },
    select: { id: true, name: true },
    orderBy: { id: 'asc' },
  });

  console.log(`Found ${bands.length} bands without MBID`);

  let updated = 0;
  let failed = 0;

  for (const band of bands) {
    try {
      const mbid = await fetchMBID(band.name);

      if (mbid) {
        await prisma.band.update({
          where: { id: band.id },
          data: { MBID: mbid },
        });
        console.log(`[OK]   ${band.name} → ${mbid}`);
        updated++;
      } else {
        console.log(`[MISS] ${band.name} — no match found`);
        failed++;
      }
    } catch (error) {
      console.error(`[ERR]  ${band.name} — ${error.message}`);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`\nDone. Updated: ${updated}, No match/error: ${failed}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
