import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import { installFakePrisma } from '../../test/routeApp.js';

// The album share's public routes (THO-892) live in the media router, which
// index.js mounts on /data/concerts behind several others. They take no
// bearer token, so they work only while nothing mounted ahead of them matches
// their paths: a `router.get('/:concertId/…', auth, …)` added to one of those
// would answer every recipient's page with a 401, and the route tests, which
// mount the media router alone, would go on passing.
//
// The mounts are read off index.js rather than listed here, so a router added
// ahead of media is checked too. index.js itself cannot be imported: it listens
// and starts the cron jobs.

const require = createRequire(import.meta.url);
const indexSourceTho892 = readFileSync(new URL('../../index.js', import.meta.url), 'utf8');
const concertMountsTho892 = [...indexSourceTho892.matchAll(
  /app\.use\(\s*["']\/data\/concerts["']\s*,\s*require\(\s*["']\.\/(routes\/data\/[\w/]+)["']\s*\)\s*\)/g,
)].map((m) => m[1]);

installFakePrisma({
  mediaAlbumShareLink: { findUnique: async () => null },
});

const appTho892 = express();
appTho892.use(express.json());
for (const mount of concertMountsTho892) {
  appTho892.use('/data/concerts', require(`../../${mount}`));
}

describe('album share routes behind the other /data/concerts routers', () => {
  it('reads the media router among the /data/concerts mounts, so the check below covers something', () => {
    expect(concertMountsTho892).toContain('routes/data/media');
    expect(concertMountsTho892.indexOf('routes/data/media')).toBeGreaterThan(0);
  });

  it('reaches the public listing without a token: an unknown token is a 404, not a 401 from a router ahead of it', async () => {
    const res = await request(appTho892).get('/data/concerts/album-shares/no-such-token');
    expect(res.status).toBe(404);
  });

  it('reaches the public file route without a token', async () => {
    for (const which of ['thumb', 'view', 'file']) {
      const res = await request(appTho892).get(`/data/concerts/album-shares/no-such-token/media/1/${which}`);
      expect(res.status).toBe(404);
    }
  });
});
