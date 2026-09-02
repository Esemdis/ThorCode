import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

// The proxy route under test never reaches the database, but prisma/client is
// required when the router is imported — see installFakePrisma.
installFakePrisma({ trip: {}, tripItem: {}, tripPlace: {} });

const { default: router } = await import('./trips.js');
const app = buildApp(router);

describe('a trip weather sync the Python service turns away', () => {
  // trips.js reported this through `fail`, which answers 500 and, outside
  // production, hands back the caught message — so an upstream 401 arrived as
  // this API's own 500 saying "Request failed with status code 401".
  let server;

  beforeAll(async () => {
    const { createServer } = await import('node:http');
    server = createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Unauthorized' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.PYTHON_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
    delete process.env.PYTHON_SERVICE_FALLBACK_URL;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('answers a bad gateway naming the shared secret', async () => {
    const res = await request(app).post('/sync-weather').set(...authHeader({ role: 'ADMIN' }));

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/SCRAPER_TOKEN/);
    expect(res.body.error).not.toMatch(/Request failed with status/);
  });
});
