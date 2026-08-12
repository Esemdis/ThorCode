import { describe, it, expect, vi } from 'vitest';
import { pickSetlistFor, songsFrom, fetchSetlistsForNames } from './externalSetlists.js';

// axios is not mocked here. Vitest externalises node_modules, so a CommonJS
// `require('axios')` never sees a mock — assertions written against one pass for
// the wrong reason. The parts worth testing are pure or take an injected
// fetcher instead, which is the same split as setlistPlaylist.js vs spotify.js.

const setlistFor = (artistName, songs) => ({
  artist: { name: artistName },
  url: `https://www.setlist.fm/${artistName}`,
  sets: { set: [{ song: songs.map((s) => (typeof s === 'string' ? { name: s } : s)) }] },
});

describe('songsFrom', () => {
  it('flattens the sets into the song shape used everywhere else', () => {
    const setlist = {
      sets: { set: [
        { song: [{ name: 'Intro', tape: true }, { name: 'Bloodbath' }] },
        { song: [{ name: 'Country Roads', cover: { name: 'John Denver' } }] },
      ] },
    };
    expect(songsFrom(setlist)).toEqual([
      { name: 'Intro', cover: null, tape: true },
      { name: 'Bloodbath', cover: null, tape: false },
      { name: 'Country Roads', cover: 'John Denver', tape: false },
    ]);
  });

  it('is empty for a setlist with no sets', () => {
    expect(songsFrom({})).toEqual([]);
    expect(songsFrom(undefined)).toEqual([]);
  });
});

describe('pickSetlistFor', () => {
  it('takes a setlist whose artist is the band that was asked for', () => {
    const picked = pickSetlistFor('Counterparts', [setlistFor('Counterparts', ['Bloodbath', 'Love Me'])]);
    expect(picked.artist).toBe('Counterparts');
    expect(picked.songs.map((s) => s.name)).toEqual(['Bloodbath', 'Love Me']);
  });

  it('refuses a setlist by a different artist with a similar name', () => {
    // Searching setlist.fm for "thistle." really does return Jake Thistle, a
    // singer-songwriter. Without this check his set joins a hardcore playlist.
    expect(pickSetlistFor('thistle.', [setlistFor('Jake Thistle', ['Sundown'])])).toBe(null);
  });

  it('still matches through a country suffix', () => {
    expect(pickSetlistFor('Polaris', [setlistFor('Polaris (AUS)', ['Masochist'])]).artist)
      .toBe('Polaris (AUS)');
  });

  it('skips past a matching setlist with nothing anybody played', () => {
    // A cancelled show logged with only walk-on music is not a setlist.
    const picked = pickSetlistFor('Counterparts', [
      setlistFor('Counterparts', [{ name: 'Intro', tape: true }]),
      setlistFor('Counterparts', ['Bloodbath']),
    ]);
    expect(picked.songs.map((s) => s.name)).toEqual(['Bloodbath']);
  });

  it('is null for an empty or missing response', () => {
    expect(pickSetlistFor('Counterparts', [])).toBe(null);
    expect(pickSetlistFor('Counterparts', undefined)).toBe(null);
    expect(pickSetlistFor('', [setlistFor('Counterparts', ['Bloodbath'])])).toBe(null);
  });
});

describe('fetchSetlistsForNames', () => {
  it('stops looking once the budget is spent', async () => {
    // A 57-band festival must not turn one click into a minute of waiting.
    const fetchOne = vi.fn(async (name) => ({ songs: [{ name: 'Song', tape: false, cover: null }], artist: name }));
    const names = Array.from({ length: 10 }, (_, i) => `Budget Band ${i}`);

    const found = await fetchSetlistsForNames(names, { budget: 2, fetchOne });

    expect(fetchOne).toHaveBeenCalledTimes(2);
    expect(found.size).toBe(2);
  });

  it('asks for each distinct band once, however often it is billed', async () => {
    const fetchOne = vi.fn(async (name) => ({ songs: [{ name: 'Song', tape: false, cover: null }], artist: name }));

    await fetchSetlistsForNames(['Repeat Band', 'Repeat Band', 'repeat band'], { budget: 5, fetchOne });

    expect(fetchOne).toHaveBeenCalledTimes(1);
  });

  it('leaves out a band the lookup found nothing for', async () => {
    const fetchOne = vi.fn(async () => null);
    const found = await fetchSetlistsForNames(['Never Heard Of Them'], { budget: 5, fetchOne });
    expect(found.size).toBe(0);
  });
}, 20000);
