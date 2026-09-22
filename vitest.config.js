import { defineConfig } from 'vitest/config';

/**
 * The suite ran on Vitest's defaults until now, which is why this file is new.
 *
 * It exists for one setting. Nothing reset mock implementations between tests,
 * so a `mockResolvedValue` set inside one test stayed set for every test after
 * it in the same file — which does not fail anything, it just quietly changes
 * what the later tests were exercising, and is found only by someone noticing
 * a test that should not have passed.
 *
 * mockReset restores the function given to vi.fn(fn) rather than blanking it,
 * so installFakePrisma's shapes and the $transaction fake survive it and only
 * per-test overrides go.
 */
export default defineConfig({
  test: {
    mockReset: true,
  },
});
