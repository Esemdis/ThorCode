import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';

// Prisma names a model's client property by lower-casing only the first
// character, so `model OAuth` is reached as `prisma.oAuth` — not `prisma.oauth`,
// which is what four call sites had. Nothing catches that at load time: the
// property is simply undefined, and the request dies at the first query with
// "Cannot read properties of undefined (reading 'findUnique')".
//
// Constructing the client does not connect, so this needs no database. It pins
// the accessors the code actually uses; rename a model and this fails here
// rather than in a route.
const ACCESSORS = ['oAuth', 'concert', 'band', 'concertBandReference', 'wishlist', 'user'];

describe('the Prisma client exposes the models the routes reach for', () => {
  const client = new PrismaClient();

  for (const name of ACCESSORS) {
    it(`has prisma.${name}`, () => {
      expect(typeof client[name]?.findMany).toBe('function');
    });
  }

  it('does not have the lower-cased spelling of OAuth that used to be used', () => {
    expect(client.oauth).toBeUndefined();
  });
});
