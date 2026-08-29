import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { shouldFallBack, pythonServicePost } from './pythonService.js';

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
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED']) {
      expect(shouldFallBack(connectionError(code))).toBe(true);
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
