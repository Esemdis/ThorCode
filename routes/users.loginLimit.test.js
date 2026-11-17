import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { buildApp, installFakePrisma } from '../test/routeApp.js';

// The login limits (THO-975): ten wrong passwords per IP (an IPv6 /64) and ten
// per account, each per quarter hour.

const prisma = installFakePrisma({
  user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  emailVerification: { findFirst: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  passwordReset: { upsert: vi.fn(), findUnique: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
});

const require = createRequire(import.meta.url);
const router = require('./users.js');

const app = buildApp(router, '/users');
// The limiters are module-level, so they remember every request in this file.
// Each test signs in from its own addresses and for its own email, or one
// test's guesses would spend the next one's budget.
app.set('trust proxy', 1);

const LOGIN_LIMIT_TEST_PASSWORD = 'RightHorse9';
const LOGIN_LIMIT_TEST_WRONG = 'WrongHorse9';
const LOGIN_LIMIT_TEST_MESSAGE = 'Too many failed sign-ins. Please wait a few minutes and try again.';

let loginLimitTestBlock = 0;
// A fresh run of IPv4 addresses, one per call, in a block no other test uses.
const loginLimitTestIps = () => {
  const block = ++loginLimitTestBlock;
  let n = 0;
  return () => `198.18.${block}.${++n}`;
};
let loginLimitTestAddressCounter = 0;
const loginLimitTestAddress = () => `login-limit-${++loginLimitTestAddressCounter}@example.test`;

const loginLimitTestHash = await bcrypt.hash(LOGIN_LIMIT_TEST_PASSWORD, 4);

/** Answers findMany with an account for exactly the addresses given. */
const loginLimitTestAccounts = (...emails) => {
  prisma.user.findMany.mockImplementation(async ({ where }) => {
    const asked = where?.email?.equals ?? where?.email;
    return emails
      .filter((e) => typeof asked === 'string' && e === asked.toLowerCase())
      .map((email) => ({ id: `u-${email}`, email, role: 'USER', password_hash: loginLimitTestHash }));
  });
};

const signIn = (email, password, ip) =>
  request(app).post('/users/login').set('X-Forwarded-For', ip).send({ email, password });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('POST /users/login, per account (THO-975)', () => {
  // The bug: only the IP was counted, so guesses at one account spread across
  // many addresses were never slowed.
  it('refuses the eleventh wrong password for one email even from eleven addresses', async () => {
    const email = loginLimitTestAddress();
    loginLimitTestAccounts(email);
    const ip = loginLimitTestIps();

    for (let i = 0; i < 10; i += 1) {
      expect((await signIn(email, LOGIN_LIMIT_TEST_WRONG, ip())).status).toBe(401);
    }
    const eleventh = await signIn(email, LOGIN_LIMIT_TEST_WRONG, ip());

    expect(eleventh.status).toBe(429);
    expect(eleventh.body).toEqual({ error: LOGIN_LIMIT_TEST_MESSAGE });
  });

  // Letting the right password through over budget would make the one 200
  // among the 429s say which guess was right.
  it('refuses the right password too once the email is over budget', async () => {
    const email = loginLimitTestAddress();
    loginLimitTestAccounts(email);
    const ip = loginLimitTestIps();

    for (let i = 0; i < 10; i += 1) await signIn(email, LOGIN_LIMIT_TEST_WRONG, ip());
    const right = await signIn(email, LOGIN_LIMIT_TEST_PASSWORD, ip());

    expect(right.status).toBe(429);
    expect(right.body.token).toBeUndefined();
  });

  it('counts the same email however it is capitalised or padded', async () => {
    const email = loginLimitTestAddress();
    loginLimitTestAccounts(email);
    const ip = loginLimitTestIps();

    for (let i = 0; i < 10; i += 1) {
      const typed = i % 2 ? `  ${email.toUpperCase()} ` : email;
      expect((await signIn(typed, LOGIN_LIMIT_TEST_WRONG, ip())).status).toBe(401);
    }

    expect((await signIn(email.toUpperCase(), LOGIN_LIMIT_TEST_WRONG, ip())).status).toBe(429);
  });

  // Only a wrong password is a guess. A request the validation refuses, or a
  // database that failed, must not lock the owner out.
  it('charges only a 401: neither a 400 nor a 500 counts', async () => {
    const email = loginLimitTestAddress();
    const ip = loginLimitTestIps();

    for (let i = 0; i < 12; i += 1) {
      expect((await signIn(email, 'short', ip())).status).toBe(400);
    }
    prisma.user.findMany.mockRejectedValue(new Error('database down'));
    for (let i = 0; i < 12; i += 1) {
      expect((await signIn(email, LOGIN_LIMIT_TEST_WRONG, ip())).status).toBe(500);
    }

    loginLimitTestAccounts(email);
    for (let i = 0; i < 10; i += 1) {
      expect((await signIn(email, LOGIN_LIMIT_TEST_WRONG, ip())).status).toBe(401);
    }
    expect((await signIn(email, LOGIN_LIMIT_TEST_WRONG, ip())).status).toBe(429);
  });

  // The key is the address typed, never the account found, so a 429 says
  // nothing about which addresses have an account.
  it('counts an email with no account exactly like one with an account', async () => {
    const known = loginLimitTestAddress();
    const unknown = loginLimitTestAddress();
    loginLimitTestAccounts(known);
    const ip = loginLimitTestIps();

    const answers = { known: [], unknown: [] };
    for (let i = 0; i < 11; i += 1) {
      answers.known.push((await signIn(known, LOGIN_LIMIT_TEST_WRONG, ip())).status);
      answers.unknown.push((await signIn(unknown, LOGIN_LIMIT_TEST_WRONG, ip())).status);
    }
    const over = await signIn(unknown, LOGIN_LIMIT_TEST_WRONG, ip());

    expect(answers.unknown).toEqual(answers.known);
    expect(answers.known.at(-1)).toBe(429);
    expect(over.body).toEqual({ error: LOGIN_LIMIT_TEST_MESSAGE });
  });

  it('clears the email’s count when its owner signs in', async () => {
    const email = loginLimitTestAddress();
    loginLimitTestAccounts(email);
    const ip = loginLimitTestIps();

    for (let i = 0; i < 9; i += 1) await signIn(email, LOGIN_LIMIT_TEST_WRONG, ip());
    expect((await signIn(email, LOGIN_LIMIT_TEST_PASSWORD, ip())).status).toBe(200);

    for (let i = 0; i < 10; i += 1) {
      expect((await signIn(email, LOGIN_LIMIT_TEST_WRONG, ip())).status).toBe(401);
    }
    expect((await signIn(email, LOGIN_LIMIT_TEST_WRONG, ip())).status).toBe(429);
  });

  // Something that is not an address is the validation's 400. Counted, every
  // blank email from every IP would share one bucket.
  it('leaves a value that is not an address to the validation', async () => {
    const ip = loginLimitTestIps();
    for (let i = 0; i < 12; i += 1) {
      expect((await signIn('not-an-address', LOGIN_LIMIT_TEST_WRONG, ip())).status).toBe(400);
    }
  });

  it('keeps the count for a quarter hour, then starts again', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-14T10:00:00Z') });
    const email = loginLimitTestAddress();
    loginLimitTestAccounts(email);
    const ip = loginLimitTestIps();

    for (let i = 0; i < 10; i += 1) await signIn(email, LOGIN_LIMIT_TEST_WRONG, ip());
    vi.setSystemTime(new Date('2026-11-14T10:14:50Z'));
    expect((await signIn(email, LOGIN_LIMIT_TEST_WRONG, ip())).status).toBe(429);

    vi.setSystemTime(new Date('2026-11-14T10:15:01Z'));
    expect((await signIn(email, LOGIN_LIMIT_TEST_WRONG, ip())).status).toBe(401);
  });

  // It sends no budget headers of its own: they would overwrite the per-IP
  // limiter's, and a client reading them would see one budget or the other
  // depending on which limiter ran last.
  it('leaves the budget headers to the per-IP limiter', async () => {
    const email = loginLimitTestAddress();
    loginLimitTestAccounts(email);
    const ip = loginLimitTestIps()();

    const res = await signIn(email, LOGIN_LIMIT_TEST_WRONG, ip);

    expect(res.headers['ratelimit-policy']).toBe('10;w=900');
    expect(res.headers.ratelimit).toBeUndefined();
  });
});

describe('POST /users/login, per IP (THO-975)', () => {
  // Pinned because nothing did, and the comment above the limiter records that
  // it once had the wrong numbers under a comment promising others.
  it('allows ten wrong passwords per address per 900 seconds', async () => {
    const email = loginLimitTestAddress();
    loginLimitTestAccounts(email);

    const res = await signIn(email, LOGIN_LIMIT_TEST_WRONG, loginLimitTestIps()());

    expect(res.headers['ratelimit-policy']).toBe('10;w=900');
    expect(res.headers['ratelimit-limit']).toBe('10');
  });

  // The bug: an IPv6 client owns a /64 and can send every request from a fresh
  // address in it, each of which used to get a budget of its own.
  it('treats every address in one IPv6 /64 as one client', async () => {
    loginLimitTestAccounts();
    const answers = [];
    for (let i = 1; i <= 11; i += 1) {
      const res = await signIn(loginLimitTestAddress(), LOGIN_LIMIT_TEST_WRONG, `2001:db8:975:1::${i.toString(16)}`);
      answers.push(res.status);
    }

    expect(answers.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(answers[10]).toBe(429);
    // The neighbouring /64 is someone else.
    expect((await signIn(loginLimitTestAddress(), LOGIN_LIMIT_TEST_WRONG, '2001:db8:975:2::1')).status).toBe(401);
  });
});
