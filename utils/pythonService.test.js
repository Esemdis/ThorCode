import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { shouldFallBack, pythonServicePost, pythonServiceFailure } from './pythonService.js';

// A stand-in client rather than a module mock: vitest externalises axios for
// this CommonJS module, so vi.mock silently does nothing and the tests reach
// the real network.
const post = vi.fn();
const client = { post };

const connectionError = (code) => Object.assign(new Error(code), { code, request: {} });
const httpError = (status) => Object.assign(new Error(`Request failed with status ${status}`), {
  response: { status, data: { error: 'nope' } },
});

describe('shouldFallBack', () => {
  it('falls back when the service could not be reached at all', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH']) {
      expect(shouldFallBack(connectionError(code))).toBe(true);
    }
  });

  it('does not fall back when the request may have arrived', () => {
    // An axios timeout on a five-minute sync is a job still running, and a
    // reset can land mid-response. Retrying either elsewhere ran the scrape
    // twice — exactly what the fallback exists never to do.
    for (const code of ['ECONNABORTED', 'ECONNRESET']) {
      expect(shouldFallBack(connectionError(code))).toBe(false);
    }
  });

  it('does not fall back when the service answered', () => {
    // A 500 means the worker ran and failed. Retrying elsewhere would run the
    // same scrape a second time rather than fixing anything.
    expect(shouldFallBack(httpError(500))).toBe(false);
    expect(shouldFallBack(httpError(400))).toBe(false);
  });

  it('does not fall back on an error that never became a request', () => {
    // A bug on our side is not an unreachable host, and retrying it against
    // production would just run the bug there.
    expect(shouldFallBack(new TypeError('bad argument'))).toBe(false);
  });
});

describe('pythonServicePost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PYTHON_SERVICE_URL = 'http://127.0.0.1:8000';
    process.env.PYTHON_SERVICE_FALLBACK_URL = 'https://sync.example.dev';
  });

  afterEach(() => {
    delete process.env.PYTHON_SERVICE_FALLBACK_URL;
  });

  it('uses the configured service when it answers', async () => {
    post.mockResolvedValue({ data: { ok: true } });

    const res = await pythonServicePost('/trigger', {}, {}, client);

    expect(res.data).toEqual({ ok: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('http://127.0.0.1:8000/trigger');
  });

  it('retries against the fallback when the service is unreachable', async () => {
    post
      .mockRejectedValueOnce(connectionError('ECONNREFUSED'))
      .mockResolvedValueOnce({ data: { ok: true } });

    const res = await pythonServicePost('/sync/171', { band_name: 'Amity' }, {}, client);

    expect(res.data).toEqual({ ok: true });
    expect(post.mock.calls[1][0]).toBe('https://sync.example.dev/sync/171');
    // The body has to survive the retry, or the fallback syncs the wrong thing.
    expect(post.mock.calls[1][1]).toEqual({ band_name: 'Amity' });
  });

  it('does not retry when the service answered with an error', async () => {
    post.mockRejectedValue(httpError(500));

    await expect(pythonServicePost('/trigger', {}, {}, client)).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('gives up when no fallback is configured', async () => {
    // Production leaves this unset, so it can never fall back to itself.
    delete process.env.PYTHON_SERVICE_FALLBACK_URL;
    post.mockRejectedValue(connectionError('ECONNREFUSED'));

    await expect(pythonServicePost('/trigger', {}, {}, client)).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to the URL it just failed on', async () => {
    // Same value in both vars would otherwise mean two identical attempts.
    process.env.PYTHON_SERVICE_FALLBACK_URL = 'http://127.0.0.1:8000';
    post.mockRejectedValue(connectionError('ECONNREFUSED'));

    await expect(pythonServicePost('/trigger', {}, {}, client)).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('pythonServiceFailure', () => {
  it('names the shared secret when the sync service rejects our credentials', () => {
    // The failure this exists for: the service started requiring SCRAPER_TOKEN,
    // the backend was never given one, and every admin sync button answered
    // "Request failed with status code 401" — a status the caller's own login
    // had nothing to do with, and a message naming nothing to go and fix.
    const { status, message } = pythonServiceFailure(httpError(401));

    expect(status).toBe(502);
    expect(message).toMatch(/SCRAPER_TOKEN/);
  });

  it('treats a forbidden the same as an unauthorized', () => {
    expect(pythonServiceFailure(httpError(403))).toEqual(pythonServiceFailure(httpError(401)));
  });

  it('never passes axios’s own wording on to the client', () => {
    // Whatever went wrong upstream, the status in that sentence is the sync
    // service's, and repeating it here makes it read as this API's own.
    for (const upstream of [401, 403, 404, 429, 500, 503]) {
      const { message } = pythonServiceFailure(httpError(upstream));
      expect(message).not.toMatch(/Request failed with status/);
    }
  });

  it('answers a bad gateway when the sync service itself failed', () => {
    const { status, message } = pythonServiceFailure(httpError(500));

    expect(status).toBe(502);
    expect(message).toMatch(/500/);
  });

  it('answers service unavailable when nothing answered at all', () => {
    // Distinct from the above on purpose: nothing ran, so retrying is safe.
    // A 502 would say the scrape happened and went wrong.
    expect(pythonServiceFailure(connectionError('ECONNREFUSED')).status).toBe(503);
  });

  it('answers a gateway timeout when the request went out and nothing came back', () => {
    const { status, message } = pythonServiceFailure(connectionError('ECONNABORTED'));
    expect(status).toBe(504);
    expect(message).toMatch(/may still be running/);
  });

  it('keeps a bug on our own side a plain server error', () => {
    // No request was ever made, so blaming the sync service would send the
    // next person to read the wrong service's logs.
    expect(pythonServiceFailure(new TypeError('bad argument')).status).toBe(500);
  });
});
