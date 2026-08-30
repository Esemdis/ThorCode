import express from 'express';
import jwt from 'jsonwebtoken';

// The routers verify real tokens, so the tests sign real ones rather than
// stubbing the middleware out — that way "does this endpoint actually require
// auth" is a thing the suite can answer.
process.env.JWT_SECRET ||= 'test-secret';

// prisma/client.js parses this at import time to add pool settings, so it has
// to be a valid URL even in a suite that mocks the client away — otherwise the
// import throws before any mock can take effect. Nothing connects: constructing
// a PrismaClient is lazy, and the tests replace it anyway.
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';

/**
 * Mounts one router the way index.js does, error handler included.
 *
 * The handler matters: several routes signal failure by calling next(err) with
 * a status, and without it supertest sees Express's HTML error page instead of
 * the JSON body the client is written against.
 */
export function buildApp(router, mount = '/') {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  app.use((err, req, res, _next) => {
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message || 'Internal server error' });
  });
  return app;
}

/** A bearer header for a user with the given id and role. */
export function authHeader(user = {}) {
  const token = jwt.sign({ id: 'user-1', role: 'USER', ...user }, process.env.JWT_SECRET);
  return ['Authorization', `Bearer ${token}`];
}

/**
 * Installs a stand-in for the Prisma client, before any route imports it.
 *
 * `vi.mock` cannot reach it: the routers are CommonJS and their `require` of
 * prisma/client resolves outside the module graph vitest can intercept, so the
 * real client got constructed and the tests talked to a real database.
 *
 * prisma/client.js already reuses `global.prisma` when one is set — that exists
 * so nodemon restarts do not open a new pool every reload — so seeding it is
 * enough, and no source has to change to be testable. Must be called before the
 * router is imported, which means the router needs a dynamic `await import`
 * rather than a static one.
 *
 * @param {object} fake - the model accessors the routes under test reach for.
 */
export function installFakePrisma(fake) {
  globalThis.prisma = fake;
  return fake;
}

/**
 * Every route a router registers, in order, as `METHOD /path [handlerCount]`.
 *
 * The handler count is part of it on purpose: it is how many middlewares sit in
 * front of the handler, so dropping an `auth` or a `roleCheck` while moving a
 * route between files changes the string and fails the test. Order is part of
 * it too — Express matches in registration order, and splitting one router into
 * several is exactly the change that can silently reorder two overlapping
 * patterns.
 */
export function routeManifest(router) {
  const out = [];
  walk(router, out);
  return out;
}

// Recurses into mounted sub-routers so the manifest reads the same whether a
// router declares its routes itself or delegates them to several modules.
// Without this, splitting a router into sub-routers would empty the manifest
// rather than fail it, and the test meant to guard the split would pass by
// checking nothing.
function walk(router, out) {
  for (const layer of router?.stack ?? []) {
    if (layer.route) {
      const method = Object.keys(layer.route.methods)[0].toUpperCase();
      out.push(`${method} ${layer.route.path} [${layer.route.stack.length}]`);
    } else if (layer.handle?.stack) {
      walk(layer.handle, out);
    }
  }
}
