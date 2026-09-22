import { describe, it, expect } from 'vitest';
import { installFakePrisma, routeManifest } from '../test/routeApp.js';

// Nothing here reaches the database — the point is that the module loads at all
// — but prisma/client is required when the router is imported.
installFakePrisma({ user: {}, emailChange: {} });

const { default: router } = await import('./users.js');

/** The layer stack Express built for one registered route. */
function handlersFor(path) {
  const layer = router.stack.find((l) => l.route?.path === path);
  return layer.route.stack.map((s) => s.handle);
}

describe('the email change routes', () => {
  // routes/users.js destructured `emailRateLimiter`, a name utils/emailRateLimiter
  // never exported, so express-rate-limit got `undefined` as a handler and the
  // whole server refused to boot on require: "argument handler must be a
  // function". A missing import reads as a working route until start-up.
  it('registers with every middleware the route declares', () => {
    const manifest = routeManifest(router);

    expect(manifest).toContain('POST /email/request-change [4]');
    expect(manifest).toContain('POST /email/verify-code [4]');
  });

  // The two limiters exist separately on purpose: sending a code costs a real
  // email and is capped at 3, while guessing a code someone already has is
  // allowed 8. Pointing both routes at one limiter would let three wrong
  // guesses spend the whole budget for asking again.
  it('meters requesting a code separately from guessing one', () => {
    const request = handlersFor('/email/request-change');
    const verify = handlersFor('/email/verify-code');

    expect(request[1]).not.toBe(verify[1]);
  });
});
