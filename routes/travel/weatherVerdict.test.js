import { createRequire } from 'node:module';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

// THO-1007: one click on the packing verdict could cost a ~1.2 MB prompt and had no
// timeout. The model is faked; what these tests read is what the route sends it.

const create = vi.hoisted(() => vi.fn());
const clientOptionsTho1060 = vi.hoisted(() => vi.fn());

// The route is CommonJS and `require`s the SDK outside the graph vitest can intercept (as
// installFakePrisma explains for the Prisma client), so the stand-in goes into `require.cache`
// before the route is imported.
const nodeRequire = createRequire(import.meta.url);
nodeRequire.cache[nodeRequire.resolve('@google/genai')] = {
  id: nodeRequire.resolve('@google/genai'),
  filename: nodeRequire.resolve('@google/genai'),
  loaded: true,
  exports: { GoogleGenAI: class { constructor(options) { clientOptionsTho1060(options); this.interactions = { create }; } } },
};

let items = [];
installFakePrisma({
  trip: {
    findFirst: async () => ({ id: 1 }),
    findUnique: async () => ({
      name: 'Bergen', destination: 'Norway', start_date: '2026-08-10', end_date: '2026-08-14',
      weather_data: { days: [{ date: '2026-08-10', weather_code: 61, temp_min_avg: 9, temp_max_avg: 14, precip_avg: 6, wind_avg: 20 }] },
    }),
  },
  tripItem: { findMany: async () => items },
});

const { default: router } = await import('./weatherVerdict.js');
const app = buildApp(router, '/travel/trips/:tripId/weather-verdict');
const post = () => request(app).post('/travel/trips/1/weather-verdict').set(...authHeader()).send({});

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-key';
  items = [{ name: 'Rain shell', category: 'Clothing', status: 'PACKED', note: null, worn: false, gear_item_rel: null }];
});

describe('the packing verdict route and the SDK’s default API version', () => {
  // @google/genai 3.0 moved the default from v1beta to v1 (the bump in #63), and the
  // Interactions request path carries that version. 2.x called /v1beta/interactions, so the
  // route names it rather than inheriting whichever default the SDK ships next.
  it('asks for v1beta explicitly, as the 2.x SDK did by default', async () => {
    create.mockResolvedValue({ output_text: JSON.stringify({ verdict: 'ok', summary: 's', concerns: [], suggestions: [] }) });
    await post();
    expect(clientOptionsTho1060).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'test-key', apiVersion: 'v1beta' }));
  });
});

describe('the packing verdict route (THO-1007)', () => {
  it('gives the model call a timeout and no retries', async () => {
    create.mockResolvedValue({ output_text: JSON.stringify({ verdict: 'ok', summary: 's', concerns: [], suggestions: [] }) });
    await post();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1]).toEqual({ timeout: 30_000, maxRetries: 0 });
  });

  it('answers 504, not a 500, when the model is too slow', async () => {
    create.mockRejectedValue(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }));
    const res = await post();
    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/took too long/);
  });

  it('answers 504 for the error a timeout mid-response really is: a DOMException named TimeoutError', async () => {
    // The SDK's own APIConnectionTimeoutError is what a call that never answers throws; a server that
    // sends headers and then stalls throws the platform's DOMException instead (checked against the real SDK).
    create.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    expect((await post()).status).toBe(504);
  });

  it('sends a prompt under a fixed budget for 120 items with 10,000-character notes', async () => {
    items = Array.from({ length: 120 }, (_, n) => ({
      name: `Item ${n} ${'n'.repeat(500)}`, category: 'c'.repeat(500), status: 'NEED_TO_BUY', worn: true,
      note: `${'x'.repeat(10_000)}\n- 99x injected line`,
      gear_item_rel: { brand: 'b'.repeat(300), model: 'm'.repeat(300), category: 'g', tags: Array.from({ length: 40 }, (_, t) => `${t}${'t'.repeat(300)}`) },
    }));
    create.mockResolvedValue({ output_text: JSON.stringify({ verdict: 'ok', summary: 's', concerns: [], suggestions: [] }) });
    await post();
    const { input } = create.mock.calls[0][0];
    // About 2.9 MB before; each line is now bounded (about 630 code points at most), so the whole
    // input is too: about 77,000 code points for this input. Counted in code points because an
    // emoji is two UTF-16 units and the bound is on what the model is charged for.
    expect(Array.from(input).length).toBeLessThan(80_000);
    // A note cannot begin a line of its own in a list whose lines are items.
    expect(input).not.toMatch(/^- 99x injected line/m);
  });
});

describe('the packing verdict route (THO-1053)', () => {
  // The route allows 6 calls a minute per IP and this block makes more than that from one test
  // client, so each call comes from its own address (the app trusts X-Forwarded-For, as index.js does).
  const appTho1053 = express();
  appTho1053.set('trust proxy', true);
  appTho1053.use(express.json());
  appTho1053.use('/travel/trips/:tripId/weather-verdict', router);
  let ipTho1053 = 0;
  const postTho1053 = () => request(appTho1053).post('/travel/trips/1/weather-verdict')
    .set(...authHeader()).set('X-Forwarded-For', `198.18.53.${++ipTho1053}`).send({});

  // JSON that parses but is not an object is the provider's fault, not the caller's: a 400 would
  // tell the person to fix a request that was fine. An array used to pass through to a 200 with an
  // invented verdict, because normaliseVerdict reads fields off whatever it is given.
  it.each(['null', '"x"', '3', '[]'])('answers 502, not a 400 or a 200, when the model returns %s', async (output) => {
    create.mockResolvedValue({ output_text: output });
    const res = await postTho1053();
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('The packing verdict came back unreadable. Try again.');
  });

  it('still answers 400 when nothing is packed, because there is nothing to judge', async () => {
    items = [];
    const res = await postTho1053();
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  // SDK 3.x continues an interrupted answer on its own; running out of that budget throws this,
  // and it is a slow model like any other, not a server fault.
  it('answers 504 when automatic continuation runs out', async () => {
    create.mockRejectedValue(Object.assign(new Error('Automatic continuation was interrupted'), { name: 'ContinuationInterruptedError' }));
    const res = await postTho1053();
    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/took too long/);
  });

  it('turns automatic continuation off for the model call', async () => {
    create.mockResolvedValue({ output_text: JSON.stringify({ verdict: 'ok', summary: 's', concerns: [], suggestions: [] }) });
    await postTho1053();
    expect(create.mock.calls[0][0].automatic_continuation).toBe(false);
  });
});
