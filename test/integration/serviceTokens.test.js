/**
 * Withdrawing one minted token (THO-1016) against Postgres: a token minted the
 * way scripts/generate-service-token.js mints it works, and once its row is
 * withdrawn it stops working when verifyJWT's minute-long cache runs out,
 * while the same account's other token keeps working.
 *
 * Skipped unless INTEGRATION_DATABASE_URL is set; see regressions.test.js.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const url = process.env.INTEGRATION_DATABASE_URL;
const require = createRequire(import.meta.url);

describe.skipIf(!url)('withdrawing a minted token', () => {
  let prisma;
  let app;
  let tokenScopes;
  const RUN = `st${Date.now()}`;

  beforeAll(() => {
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET ||= 'integration-secret';
    prisma = require('../../prisma/client.js');
    tokenScopes = require('../../auth/tokenScopes.js');
    const verifyJWT = require('../../auth/verifyJWT.js');
    app = express().get('/whoami', verifyJWT, (req, res) => res.json({ id: req.user.id }));
  });

  afterEach(() => { vi.useRealTimers(); });

  afterAll(async () => {
    // The token rows go with their user (onDelete: Cascade).
    await prisma.user.deleteMany({ where: { id: { startsWith: RUN } } });
    await prisma.$disconnect();
  });

  // As the script does it: the row first, then a token whose jti is its id.
  async function mintServiceToken1016(user) {
    const expiresAt = tokenScopes.serviceTokenExpiry(365);
    const row = await prisma.serviceToken.create({ data: { user_id: user.id, expires_at: expiresAt } });
    const claims = tokenScopes.serviceTokenClaims(user, { jti: row.id, expiresAt: row.expires_at });
    return { row, bearer: `Bearer ${jwt.sign(claims, process.env.JWT_SECRET)}` };
  }

  it('refuses a withdrawn token once the cache runs out, and leaves the account\'s other token working', async () => {
    const user = await prisma.user.create({ data: { id: `${RUN}-sync`, email: `${RUN}-sync@example.test`, role: 'SYSTEM' } });
    const withdrawn = await mintServiceToken1016(user);
    const kept = await mintServiceToken1016(user);

    expect((await request(app).get('/whoami').set('Authorization', withdrawn.bearer)).status).toBe(200);
    expect((await request(app).get('/whoami').set('Authorization', kept.bearer)).status).toBe(200);

    await prisma.serviceToken.update({ where: { id: withdrawn.row.id }, data: { withdrawn_at: new Date() } });

    // Only Date is faked, so the database driver's own timers run as usual.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61 * 1000);

    const after = await request(app).get('/whoami').set('Authorization', withdrawn.bearer);
    expect(after.status).toBe(401);
    expect(after.body).toEqual({ error: 'Invalid or expired token' });
    const other = await request(app).get('/whoami').set('Authorization', kept.bearer);
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ id: user.id });
  });
});
