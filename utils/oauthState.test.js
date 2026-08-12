import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { signOAuthState, verifyOAuthState } from './oauthState.js';

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
