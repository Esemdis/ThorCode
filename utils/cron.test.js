import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { installFakePrisma } from '../test/routeApp.js';

// cron.js requires prisma/client at load, so the stand-in goes in first or the
// real client is built.
installFakePrisma({
  emailVerification: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  passwordReset: { deleteMany: vi.fn(async () => ({ count: 0 })) },
});

const require = createRequire(import.meta.url);
const nodeCron = require('node-cron');
const { startCronJobs, cronEnabled } = require('./cron.js');

// Every job utils/cron.js runs: digest, ticket alerts, the two hourly
// cleanups, the Spotify, source-URL and setlist backfills, and the weekly recap.
const THO974_JOB_COUNT = 8;

const quietCronLog = () => vi.spyOn(console, 'log').mockImplementation(() => {});

afterEach(() => {
  // Should a regression schedule real node-cron tasks, stop them so they
  // cannot fire against the fake client or keep the worker alive.
  for (const task of nodeCron.getTasks().values()) task.destroy?.() ?? task.stop?.();
  vi.restoreAllMocks();
});

describe('startCronJobs (THO-974)', () => {
  it('schedules nothing outside production when RUN_CRON is unset, and says so', () => {
    // dev and prd share one database, so a workstation's `npm run dev` ran
    // every job against production rows: the 09:00 digest went out twice.
    const log = quietCronLog();
    const schedule = vi.fn();

    startCronJobs({ env: { NODE_ENV: 'development' }, schedule });

    expect(schedule).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe('[cron] Scheduled jobs are off (NODE_ENV=development, RUN_CRON unset). Set RUN_CRON=1 to run them in this process.');
  });

  it('names an unset NODE_ENV as unset in the off line', () => {
    // `npm start` and `npm run dev` set no NODE_ENV at all.
    const log = quietCronLog();
    const schedule = vi.fn();

    startCronJobs({ env: {}, schedule });

    expect(schedule).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain('NODE_ENV=unset');
  });

  it('starts no real node-cron task when called the way index.js calls it', () => {
    // The test runner is not production and sets no RUN_CRON, which is what a
    // workstation looks like; index.js passes nothing.
    quietCronLog();
    const before = nodeCron.getTasks().size;

    startCronJobs();

    expect(nodeCron.getTasks().size).toBe(before);
  });

  it('schedules all eight jobs in production and logs once that they are on', () => {
    const log = quietCronLog();
    const schedule = vi.fn();

    startCronJobs({ env: { NODE_ENV: 'production' }, schedule });

    expect(schedule).toHaveBeenCalledTimes(THO974_JOB_COUNT);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/^\[cron\] Scheduled jobs are on \(NODE_ENV=production\)/);
  });

  it('schedules all eight outside production when RUN_CRON=1', () => {
    const log = quietCronLog();
    const schedule = vi.fn();

    startCronJobs({ env: { NODE_ENV: 'development', RUN_CRON: '1' }, schedule });

    expect(schedule).toHaveBeenCalledTimes(THO974_JOB_COUNT);
    expect(log.mock.calls[0][0]).toMatch(/^\[cron\] Scheduled jobs are on \(RUN_CRON=1\)/);
  });

  it('schedules nothing in production when RUN_CRON=0', () => {
    const log = quietCronLog();
    const schedule = vi.fn();

    startCronJobs({ env: { NODE_ENV: 'production', RUN_CRON: '0' }, schedule });

    expect(schedule).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain('RUN_CRON=0');
  });
});

describe('cronEnabled (THO-974)', () => {
  it.each([
    [{ NODE_ENV: 'production' }, true],
    [{ NODE_ENV: 'production', RUN_CRON: '' }, true],
    [{ NODE_ENV: 'production', RUN_CRON: '1' }, true],
    [{ NODE_ENV: 'production', RUN_CRON: '0' }, false],
    [{ NODE_ENV: 'development', RUN_CRON: '1' }, true],
    [{ RUN_CRON: '1' }, true],
    [{}, false],
    [{ NODE_ENV: 'development' }, false],
    // An empty RUN_CRON is what `.env_example` leaves behind: not a yes.
    [{ NODE_ENV: 'development', RUN_CRON: '' }, false],
    // Exact match on purpose: a near-miss spelling must not start the jobs
    // against the shared database.
    [{ NODE_ENV: 'Production' }, false],
    [{ RUN_CRON: 'true' }, false],
  ])('%o -> %s', (env, on) => {
    expect(cronEnabled(env).on).toBe(on);
  });

  it('gives a reason either way', () => {
    expect(cronEnabled({ NODE_ENV: 'production' }).reason).toBe('NODE_ENV=production');
    expect(cronEnabled({ RUN_CRON: '1' }).reason).toBe('RUN_CRON=1');
    expect(cronEnabled({}).reason).toBe('NODE_ENV=unset, RUN_CRON unset');
  });
});
