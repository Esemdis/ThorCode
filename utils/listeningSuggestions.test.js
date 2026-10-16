import { describe, it, expect } from 'vitest';
import { grantsScope, suggestFromListening } from './listeningSuggestions.js';

const row = (id, name) => ({ id, name });

describe('suggestFromListening', () => {
  it('drops an artist whose Spotify id is on the wishlist even when the names differ', () => {
    // The band was renamed or added by a scraper spelling; the id is the truth.
    const out = suggestFromListening(
      [{ service: 'spotify', rows: [row('sp1', 'Ghost'), row('sp2', 'Spiritbox')] }],
      [{ name: 'Ghost (SWE)', spotify_id: 'sp1' }],
    );
    expect(out.map((a) => a.name)).toEqual(['Spiritbox']);
  });

  it('falls back to the canonical name for a band with no Spotify id stored', () => {
    const out = suggestFromListening(
      [{ service: 'spotify', rows: [row('a', 'Mötley Crüe'), row('b', 'OPETH'), row('c', 'Leprous')] }],
      [{ name: 'Motley Crue', spotify_id: null }, { name: 'Opeth' }],
    );
    expect(out.map((a) => a.name)).toEqual(['Leprous']);
  });

  it('matches a Tidal row by name only, since no band stores a Tidal id', () => {
    const out = suggestFromListening(
      [{ service: 'tidal', rows: [row('tidal:9', 'The Ocean'), row('tidal:8', 'Tesseract')] }],
      [{ name: 'The Ocean', spotify_id: 'sp-ocean' }],
    );
    expect(out).toEqual([{ id: 'tidal:8', name: 'Tesseract', service: 'tidal' }]);
  });

  it('lists an artist on both services once, as the first service named it', () => {
    // Spotify goes first because its row carries an image and a link.
    const out = suggestFromListening(
      [
        { service: 'spotify', rows: [row('a', 'Opeth')] },
        { service: 'tidal', rows: [row('tidal:1', 'opeth'), row('tidal:2', 'Leprous')] },
      ],
      [],
    );
    expect(out.map((a) => [a.id, a.service])).toEqual([['a', 'spotify'], ['tidal:2', 'tidal']]);
  });

  it('keeps a top artist ahead of the same artist repeated among the followed ones', () => {
    const out = suggestFromListening(
      [{ service: 'spotify', rows: [row('a', 'Opeth'), row('b', 'Gojira'), row('a', 'Opeth')] }],
      [],
    );
    expect(out.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('does not let names that canonicalise to nothing hide each other', () => {
    // Two punctuation-only names are both '' once canonical; matching on that
    // would drop the second artist, and a wishlist band named "!!!" would drop
    // every such artist.
    const out = suggestFromListening(
      [{ service: 'spotify', rows: [row('x', '!!!'), row('y', '???')] }],
      [{ name: '...', spotify_id: null }],
    );
    expect(out.map((a) => a.id)).toEqual(['x', 'y']);
  });

  it('skips rows without an id or a name rather than suggesting a blank', () => {
    const out = suggestFromListening(
      [{ service: 'spotify', rows: [row('', 'Nameless id'), row('z', ''), null, row('ok', 'Kept')] }],
      undefined,
    );
    expect(out.map((a) => a.id)).toEqual(['ok']);
  });
});

describe('grantsScope', () => {
  it('reads a space-separated grant', () => {
    expect(grantsScope('playlist-modify-private user-top-read', 'user-top-read')).toBe(true);
    expect(grantsScope('playlist-modify-private user-top-read', 'user-follow-read')).toBe(false);
  });

  it('does not take a scope for a prefix of another', () => {
    expect(grantsScope('user-follow-read-ish', 'user-follow-read')).toBe(false);
  });

  it('says it does not know when the row stored no grant, rather than "missing"', () => {
    // A null here must not turn into "reconnect": the read is tried and a 403
    // decides, so a connection whose token response carried no scope keeps working.
    expect(grantsScope(null, 'user-top-read')).toBeNull();
    expect(grantsScope('  ', 'user-top-read')).toBeNull();
  });
});
