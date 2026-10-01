import { describe, it, expect, vi } from 'vitest';
import {
  searchQuery, searchedTracks, includedNames, playlistUrl, chooseTrack, MAX_ARTIST_LOOKUPS,
} from './tidalTracks.js';

const trackResource = (id, title, version = null) => ({ id, type: 'tracks', attributes: { title, version } });

// A search document the way Tidal sends one: one searchResults resource whose
// relationship holds the ranking, and the tracks themselves in `included`, in
// no promised order.
const searchDoc = (ranked, included = ranked) => ({
  data: [{
    id: 'q', type: 'searchResults',
    relationships: { tracks: { data: ranked.map((t) => ({ id: t.id, type: 'tracks' })) } },
  }],
  included: [...included].reverse(),
});

describe('searchQuery', () => {
  it('is the title and artist as free text, since Tidal has no field syntax', () => {
    expect(searchQuery({ title: 'Blind', artist: 'Korn' })).toBe('Blind Korn');
  });

  it('keeps quotes, which only mattered to Spotify\'s fielded query', () => {
    expect(searchQuery({ title: 'The "Fake" Song', artist: 'X' })).toBe('The "Fake" Song X');
  });

  it('stays inside the 256 characters the API accepts', () => {
    expect(searchQuery({ title: 'a'.repeat(300), artist: 'Korn' })).toHaveLength(256);
  });

  it('has nothing to search for without a title', () => {
    expect(searchQuery({ title: '  ', artist: 'Korn' })).toBeNull();
  });
});

describe('searchedTracks', () => {
  it('follows the ranking in the relationship, not the order of `included`', () => {
    const a = trackResource('1', 'Blind');
    const b = trackResource('2', 'Blind', 'Live');

    expect(searchedTracks(searchDoc([a, b]))).toEqual([
      { id: '1', title: 'Blind', version: null },
      { id: '2', title: 'Blind', version: 'Live' },
    ]);
  });

  it('falls back to `included` when the relationship carries no ranking', () => {
    const doc = { data: [{ id: 'q', type: 'searchResults', relationships: { tracks: { links: {} } } }], included: [trackResource('9', 'Blind')] };

    expect(searchedTracks(doc).map((t) => t.id)).toEqual(['9']);
  });

  it('leaves out the artists and albums a search also includes', () => {
    const doc = searchDoc([trackResource('1', 'Blind')]);
    doc.included.push({ id: '1', type: 'artists', attributes: { name: 'Korn' } });

    expect(searchedTracks(doc)).toHaveLength(1);
  });

  it('is empty for a search that found nothing, or no document at all', () => {
    expect(searchedTracks({ data: [{ id: 'q', type: 'searchResults' }] })).toEqual([]);
    expect(searchedTracks(undefined)).toEqual([]);
  });
});

describe('includedNames', () => {
  it('names the included resources in the order the data lists them', () => {
    const doc = {
      data: [{ id: 'b', type: 'artists' }, { id: 'a', type: 'artists' }],
      included: [
        { id: 'a', type: 'artists', attributes: { name: 'Corey Taylor' } },
        { id: 'b', type: 'artists', attributes: { name: 'Slipknot' } },
      ],
    };

    expect(includedNames(doc, 'artists')).toEqual(['Slipknot', 'Corey Taylor']);
  });
});

describe('playlistUrl', () => {
  it('uses the share link Tidal gives', () => {
    const resource = {
      id: 'abc',
      attributes: { externalLinks: [{ href: 'https://tidal.com/browse/playlist/abc', meta: { type: 'TIDAL_SHARING' } }] },
    };

    expect(playlistUrl(resource)).toBe('https://tidal.com/browse/playlist/abc');
  });

  it('still has somewhere to send you when it gives none', () => {
    expect(playlistUrl({ id: 'abc', attributes: { externalLinks: [] } })).toBe('https://tidal.com/playlist/abc');
  });
});

describe('chooseTrack', () => {
  const wanted = { title: 'Duality', artist: 'Slipknot' };
  const noLookups = () => { throw new Error('should not need the artists'); };

  it('takes the only track with the right name without asking who recorded it', async () => {
    // Most songs: one search, no artist lookups. Only a tie costs more.
    const candidates = [
      { id: '1', title: 'Psychosocial', version: null },
      { id: '2', title: 'Duality', version: null },
    ];

    expect((await chooseTrack(candidates, wanted, noLookups)).id).toBe('2');
  });

  it('settles a tie on name by who recorded it', async () => {
    // A tribute act's cover ranked above the original.
    const candidates = [
      { id: 'cover', title: 'Duality', version: null },
      { id: 'real', title: 'Duality', version: null },
    ];
    const artists = { cover: ['Vitamin String Quartet'], real: ['Slipknot'] };

    const best = await chooseTrack(candidates, wanted, async (id) => artists[id]);

    expect(best.id).toBe('real');
  });

  it('puts the album cut before a live take of the same song', async () => {
    // Tidal keeps "Live" in `version`, not the title, so the two tie on name.
    // Searching the band's own name, the live one often ranks first.
    const candidates = [
      { id: 'live', title: 'Duality', version: 'Live at Download' },
      { id: 'album', title: 'Duality', version: null },
    ];

    const best = await chooseTrack(candidates, wanted, async () => ['Slipknot']);

    expect(best.id).toBe('album');
  });

  it('stops asking after a few, and takes the best guess on name', async () => {
    const candidates = Array.from({ length: 6 }, (_, i) => ({ id: String(i), title: 'Duality', version: null }));
    const lookup = vi.fn(async () => ['Someone Else']);

    const best = await chooseTrack(candidates, wanted, lookup);

    expect(lookup).toHaveBeenCalledTimes(MAX_ARTIST_LOOKUPS);
    expect(best.id).toBe('0');
  });

  it('takes the first hit when nothing has the right name, as on Spotify', async () => {
    const candidates = [{ id: '1', title: 'Duality - Live', version: null }];

    expect((await chooseTrack(candidates, wanted, noLookups)).id).toBe('1');
  });

  it('is null when the search found nothing', async () => {
    expect(await chooseTrack([], wanted, noLookups)).toBeNull();
  });
});
