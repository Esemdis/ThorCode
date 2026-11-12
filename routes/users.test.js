import { describe, it, expect } from 'vitest';
import { installFakePrisma, routeManifest } from '../test/routeApp.js';

// Nothing here reaches the database — the point is that the module loads at all
// — but prisma/client is required when the router is imported.
installFakePrisma({ user: {}, emailChange: {}, passwordReset: {} });

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

    expect(manifest).toContain('POST /email/request-change [5]');
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

describe('the forgotten-password routes (THO-808)', () => {
  // Forgot: IP limit, multipart, address limit, handler. Reset: guess limit,
  // multipart, register's password rules, handler. Neither takes `auth`: the
  // person asking is, by definition, not signed in.
  it('registers both, public, with their limiters and the password rules', () => {
    const manifest = routeManifest(router);

    expect(manifest).toContain('POST /password/forgot [4]');
    expect(manifest).toContain('POST /password/reset [4]');
  });

  it('meters asking for a link separately from using one', () => {
    const forgot = handlersFor('/password/forgot');
    const reset = handlersFor('/password/reset');

    expect(forgot[0]).not.toBe(reset[0]);
    expect(forgot[0]).not.toBe(forgot[2]);
  });
});

describe('changing the password and deleting the account (THO-810)', () => {
  // `/me` has a GET too, so the layer is picked by method as well as path.
  const accountSettingsHandlers = (method, path) => router.stack
    .find((l) => l.route?.path === path && l.route.methods[method])
    .route.stack.map((s) => s.handle);

  // Password: auth, wrong-password limit, multipart, the new password's
  // rules, handler. Delete: the same without the rules.
  it('registers both behind auth and the wrong-password limit', () => {
    const manifest = routeManifest(router);

    expect(manifest).toContain('PATCH /me/password [5]');
    expect(manifest).toContain('DELETE /me [4]');
  });

  // One budget of guesses at the current password per account, not one for
  // each route a stolen session could guess through.
  it('shares one wrong-password limit between the two', () => {
    const change = accountSettingsHandlers('patch', '/me/password');
    const remove = accountSettingsHandlers('delete', '/me');

    expect(change[1]).toBe(remove[1]);
  });
});
