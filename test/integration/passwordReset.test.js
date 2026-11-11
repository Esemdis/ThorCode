/**
 * Forgotten-password links (THO-808) against Postgres.
 *
 * The unit tests fake Prisma, and there a lost race is a `$transaction` mock
 * told to reject with P2025. Only a real database shows the thing that test
 * stands for: two submits of one link, at once, change the password once, and
 * the loser's delete finds nothing and rolls its own update back.
 *
 * Skipped unless INTEGRATION_DATABASE_URL is set; see regressions.test.js.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import bcrypt from 'bcrypt';

const url = process.env.INTEGRATION_DATABASE_URL;
const require = createRequire(import.meta.url);

describe.skipIf(!url)('password reset links', () => {
  let prisma;
  let app;
  let mail;
  const RUN = `pr${Date.now()}`;
  let passwordResetIntIp = 0;
  const passwordResetIntNextIp = () => `203.0.113.${++passwordResetIntIp}`;
  const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

  beforeAll(() => {
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET ||= 'integration-secret';
    prisma = require('../../prisma/client.js');
    mail = require('../../utils/mail.js');
    app = express().set('trust proxy', 1).use(express.json()).use('/users', require('../../routes/users.js'));
  });

  afterAll(async () => {
    // The reset rows go with their users (onDelete: Cascade).
    await prisma.user.deleteMany({ where: { id: { startsWith: RUN } } });
    await prisma.$disconnect();
  });

  const makePasswordResetUser = (tag) =>
    prisma.user.create({ data: { id: `${RUN}-${tag}`, email: `${RUN}-${tag}@example.test`, password_hash: null } });

  it('changes the password once when one link is submitted twice at the same moment', async () => {
    const user = await makePasswordResetUser('race');
    const token = crypto.randomBytes(32).toString('base64url');
    await prisma.passwordReset.create({
      data: { user_id: user.id, token_hash: sha256(token), expires_at: new Date(Date.now() + 10 * 60 * 1000) },
    });

    const submit = (password) => request(app)
      .post('/users/password/reset')
      .set('X-Forwarded-For', passwordResetIntNextIp())
      .send({ token, password });
    const answers = await Promise.all([submit('RaceWinnerA1'), submit('RaceWinnerB1')]);

    expect(answers.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(answers.find((r) => r.status === 400).body.error)
      .toBe('This reset link has already been used or is not valid. Ask for a new one.');
    expect(await prisma.passwordReset.count({ where: { user_id: user.id } })).toBe(0);
    // The password the 200 was for is the one stored, not the loser's.
    const winner = answers[0].status === 200 ? 'RaceWinnerA1' : 'RaceWinnerB1';
    const { password_hash: stored } = await prisma.user.findUnique({ where: { id: user.id } });
    expect(await bcrypt.compare(winner, stored)).toBe(true);
  });

  it('mails nobody for an address that only matches an account by LIKE wildcard', async () => {
    // Prisma's insensitive equals is an ILIKE with the value unescaped, so
    // `…-w_ld@` and `…-w%@` found `…-wild@` and mailed its owner a link, each
    // variant from a fresh per-address rate-limit bucket.
    process.env.CONCERT_MAP_URL = 'https://map.example.test';
    const send = vi.spyOn(mail, 'sendPasswordResetEmail').mockResolvedValue({ data: { id: 'm' } });
    try {
      const user = await makePasswordResetUser('wild');
      const ask = (email) => request(app)
        .post('/users/password/forgot')
        .set('X-Forwarded-For', passwordResetIntNextIp())
        .send({ email });

      await ask(`${RUN}-w_ld@example.test`);
      await ask(`${RUN}-w%@example.test`);
      // The real address last, so there is something to wait for: the
      // wildcard requests' detached work ran before this one's did.
      await ask(user.email);
      await vi.waitFor(() => expect(send).toHaveBeenCalled());
      await new Promise((resolve) => { setTimeout(resolve, 300); });

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0].to).toBe(user.email);
    } finally {
      send.mockRestore();
      delete process.env.CONCERT_MAP_URL;
    }
  });

  it('keeps one live link per user when asked twice', async () => {
    process.env.CONCERT_MAP_URL = 'https://map.example.test';
    const send = vi.spyOn(mail, 'sendPasswordResetEmail').mockResolvedValue({ data: { id: 'm' } });
    try {
      const user = await makePasswordResetUser('twice');
      const ask = () => request(app)
        .post('/users/password/forgot')
        .set('X-Forwarded-For', passwordResetIntNextIp())
        .send({ email: user.email });

      await ask();
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      await ask();
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

      const rows = await prisma.passwordReset.findMany({ where: { user_id: user.id } });
      const lastToken = new URL(send.mock.calls[1][0].link).searchParams.get('token');
      expect(rows).toHaveLength(1);
      expect(rows[0].token_hash).toBe(sha256(lastToken));
    } finally {
      send.mockRestore();
      delete process.env.CONCERT_MAP_URL;
    }
  });
});
