import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  signOAuthState, verifyOAuthState, pkceVerifier, pkceChallenge,
} from './oauthState.js';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('signOAuthState / verifyOAuthState', () => {
  it('carries the user back through the round trip', () => {
    const state = signOAuthState({ user: 'user-1', purpose: 'spotify_oauth' });
    expect(verifyOAuthState(state, 'spotify_oauth')).toEqual({ user: 'user-1' });
  });

  it('rejects a state minted for a different flow', () => {
    const state = signOAuthState({ user: 'user-1', purpose: 'tidal_oauth' });
    expect(verifyOAuthState(state, 'spotify_oauth')).toBe(null);
  });

  it('rejects an ordinary session token handed in as state', () => {
    // The whole reason for the purpose claim: session tokens are signed with the
    // same secret, so without it one would verify here and pass for a state.
    const session = jwt.sign({ id: 'user-1', email: 'a@b.c' }, process.env.JWT_SECRET);
    expect(verifyOAuthState(session, 'spotify_oauth')).toBe(null);
  });

  it('is not signed with the session secret, so it never verifies as a login', () => {
    // It used to be, and a state handed in as a bearer token then passed
    // verifyJWT with no id — which Prisma read as "every user's rows".
    const state = signOAuthState({ user: 'user-1', purpose: 'spotify_oauth' });
    expect(() => jwt.verify(state, process.env.JWT_SECRET)).toThrow();
  });

  it('rejects a state signed with the session secret itself', () => {
    const legacy = jwt.sign({ user: 'user-1', purpose: 'spotify_oauth' }, process.env.JWT_SECRET);
    expect(verifyOAuthState(legacy, 'spotify_oauth')).toBe(null);
  });

  it('rejects a state signed with someone else\'s secret', () => {
    const forged = jwt.sign({ user: 'user-1', purpose: 'spotify_oauth' }, 'not-the-secret');
    expect(verifyOAuthState(forged, 'spotify_oauth')).toBe(null);
  });

  it('rejects a state once its window has passed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T12:00:00Z'));
    const state = signOAuthState({ user: 'user-1', purpose: 'spotify_oauth', ttlSeconds: 600 });

    vi.setSystemTime(new Date('2026-08-12T12:09:00Z'));
    expect(verifyOAuthState(state, 'spotify_oauth')).toEqual({ user: 'user-1' });

    vi.setSystemTime(new Date('2026-08-12T12:11:00Z'));
    expect(verifyOAuthState(state, 'spotify_oauth')).toBe(null);
  });

  it('rejects junk without throwing', () => {
    expect(verifyOAuthState('', 'spotify_oauth')).toBe(null);
    expect(verifyOAuthState(undefined, 'spotify_oauth')).toBe(null);
    expect(verifyOAuthState('not.a.jwt', 'spotify_oauth')).toBe(null);
    expect(verifyOAuthState({ user: 'user-1' }, 'spotify_oauth')).toBe(null);
  });

  it('refuses to mint a state with nothing to identify', () => {
    expect(() => signOAuthState({ purpose: 'spotify_oauth' })).toThrow();
    expect(() => signOAuthState({ user: 'user-1' })).toThrow();
  });
});

describe('pkceVerifier / pkceChallenge', () => {
  // Tidal's connect flow needs a PKCE secret held between the authorize
  // redirect and the token exchange. There is no session to hold it in, so it
  // is worked out from the state at both ends instead.

  it('gives the same verifier for the same state, and a different one for another', () => {
    const state = signOAuthState({ user: 'user-1', purpose: 'tidal_oauth' });
    const other = signOAuthState({ user: 'user-2', purpose: 'tidal_oauth' });

    expect(pkceVerifier(state)).toBe(pkceVerifier(state));
    expect(pkceVerifier(state)).not.toBe(pkceVerifier(other));
  });

  it('cannot be worked out from the state alone', () => {
    // The state travels in the authorize URL. A verifier that was a plain
    // hash of it would be readable by anyone who saw that URL, which is the
    // one thing PKCE exists to prevent.
    const state = signOAuthState({ user: 'user-1', purpose: 'tidal_oauth' });

    expect(pkceVerifier(state)).not.toBe(crypto.createHash('sha256').update(state).digest('base64url'));
    expect(pkceVerifier(state)).not.toContain(state.slice(0, 10));
  });

  it('is a verifier RFC 7636 accepts, with its S256 challenge', () => {
    const verifier = pkceVerifier(signOAuthState({ user: 'user-1', purpose: 'tidal_oauth' }));

    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(pkceChallenge(verifier)).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
  });
});
