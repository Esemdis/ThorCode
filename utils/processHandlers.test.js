import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';

import { onUncaughtException, onUnhandledRejection } from './processHandlers.js';

// THO-1008: the handlers logged the raw reason, and a rejected axios call carries its
// request config, the Authorization header included.
const tho1008AxiosError = () => Object.assign(new Error('Request failed with status code 401'), {
  isAxiosError: true,
  response: { status: 401 },
  config: { headers: { Authorization: 'Bearer tho1008-scraper-secret' } },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what the process logs when something escapes (THO-1008)', () => {
  it('logs an unhandled axios rejection as its status, never its config and headers', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    onUnhandledRejection(tho1008AxiosError());
    expect(log).toHaveBeenCalledWith('Unhandled promise rejection:', 401);
    expect(inspect(log.mock.calls)).not.toMatch(/tho1008-scraper-secret/);
  });

  it('logs any other rejection whole, stack included, which is what the line is for', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('db down');
    onUnhandledRejection(err);
    expect(log).toHaveBeenCalledWith('Unhandled promise rejection:', err);
  });

  it('survives a rejection with no reason at all', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => onUnhandledRejection(undefined)).not.toThrow();
  });

  it('logs an uncaught axios error as its message when nothing answered, and still exits', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const err = Object.assign(new Error('connect ECONNREFUSED'), { isAxiosError: true, config: { headers: { Authorization: 'Bearer tho1008-scraper-secret' } } });
    onUncaughtException(err);
    expect(log).toHaveBeenCalledWith('Uncaught exception:', 'connect ECONNREFUSED');
    expect(inspect(log.mock.calls)).not.toMatch(/tho1008-scraper-secret/);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
