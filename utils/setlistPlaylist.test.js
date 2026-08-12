import { describe, it, expect } from 'vitest';
import {
  buildPlaylistTracks,
  setlistForRef,
  searchQueries,
  playlistName,
  playlistDescription,
  pickBestTrack,
  concertPerformers,
  unresolvedBillNames,
  formatConcertDay,
} from './setlistPlaylist.js';

/** A ConcertBandReference row as the concert query returns it. */
const ref = (name, songs, playedSongs = null) => ({
  setlist: playedSongs ? { songs: playedSongs } : null,
  band_rel: { id: 1, name, setlist: songs ? { songs } : null },
});

const song = (name, over = {}) => ({ name, tape: false, cover: null, ...over });

describe('setlistForRef', () => {
  it('prefers the set that was played over the band\'s most recent one', () => {
    const { songs, predicted } = setlistForRef(
      ref('THROWN', [song('Guiding Light')], [song('On the Verge')]),
    );
    expect(songs.map((s) => s.name)).toEqual(['On the Verge']);
    expect(predicted).toBe(false);
  });

  it('falls back to the band\'s recent set, and says it is a prediction', () => {
    const { songs, predicted } = setlistForRef(ref('THROWN', [song('Guiding Light')]));
    expect(songs.map((s) => s.name)).toEqual(['Guiding Light']);
    expect(predicted).toBe(true);
  });

  it('treats an empty stored set as no set at all', () => {
    // A stored setlist with no songs is a setlist.fm entry someone opened and
    // never filled in — the band's recent set is better than nothing.
    const { songs, predicted } = setlistForRef(ref('THROWN', [song('Guiding Light')], []));
    expect(songs.map((s) => s.name)).toEqual(['Guiding Light']);
    expect(predicted).toBe(true);
  });

  it('returns nothing for a band with no setlist anywhere', () => {
    expect(setlistForRef(ref('THROWN', null)).songs).toEqual([]);
    expect(setlistForRef(undefined).songs).toEqual([]);
  });
});

describe('buildPlaylistTracks', () => {
  it('keeps stage order, band by band', () => {
    const tracks = buildPlaylistTracks([
      ref('Counterparts', [song('Bloodbath'), song('Whispers of Your Death')]),
      ref('THROWN', [song('On the Verge')]),
    ]);
    expect(tracks.map((t) => t.title)).toEqual(['Bloodbath', 'Whispers of Your Death', 'On the Verge']);
  });

  it('drops tape tracks, which nobody performed', () => {
    const tracks = buildPlaylistTracks([
      ref('THROWN', [song('Intro', { tape: true }), song('On the Verge')]),
    ]);
    expect(tracks.map((t) => t.title)).toEqual(['On the Verge']);
  });

  it('credits a cover to the artist who wrote it, not the band playing it', () => {
    // Searching for this under Poppy returns nothing.
    const [track] = buildPlaylistTracks([
      ref('Poppy', [song('Take Me Home, Country Roads', { cover: 'John Denver' })]),
    ]);
    expect(track).toMatchObject({ artist: 'John Denver', band: 'Poppy', isCover: true });
  });

  it('looks a shared song up once when two bands on the bill both play it', () => {
    const tracks = buildPlaylistTracks([
      ref('Falling In Reverse', [song('We Are the Champions', { cover: 'Queen' })]),
      ref('Panic! At The Disco', [song('We Are the Champions', { cover: 'Queen' })]),
    ]);
    expect(tracks).toHaveLength(1);
  });

  it('keeps two different bands\' own songs even when the titles match', () => {
    const tracks = buildPlaylistTracks([
      ref('Bad Omens', [song('Limits')]),
      ref('Paleface Swiss', [song('Limits')]),
    ]);
    expect(tracks).toHaveLength(2);
  });

  it('marks tracks from a recent set as predicted and played sets as not', () => {
    const tracks = buildPlaylistTracks([
      ref('THROWN', [song('Guiding Light')], [song('On the Verge')]),
      ref('Counterparts', [song('Bloodbath')]),
    ]);
    expect(tracks.find((t) => t.band === 'THROWN').predicted).toBe(false);
    expect(tracks.find((t) => t.band === 'Counterparts').predicted).toBe(true);
  });

  it('skips bands with no name and songs with no title', () => {
    const tracks = buildPlaylistTracks([
      { setlist: null, band_rel: { name: null, setlist: { songs: [song('Orphan')] } } },
      ref('THROWN', [song('   '), song('On the Verge')]),
    ]);
    expect(tracks.map((t) => t.title)).toEqual(['On the Verge']);
  });

  it('returns [] for anything that is not a list of bands', () => {
    expect(buildPlaylistTracks(null)).toEqual([]);
    expect(buildPlaylistTracks('THROWN')).toEqual([]);
  });

  it('leaves a normal bill alone — the cap is only for festivals', () => {
    const tracks = buildPlaylistTracks([ref('THROWN', [song('a'), song('b'), song('c')])]);
    expect(tracks).toHaveLength(3);
  });

  it('keeps every band when a festival bill runs past the cap', () => {
    // Truncating the flat list would drop the bands at the bottom of the bill
    // entirely. Rock im Park 2026 is 47 bands and 330 songs.
    const bands = ['A', 'B', 'C', 'D'].map((n) => ref(n, [song(`${n}1`), song(`${n}2`), song(`${n}3`)]));
    const tracks = buildPlaylistTracks(bands, { maxTracks: 6 });
    expect(tracks).toHaveLength(6);
    expect([...new Set(tracks.map((t) => t.band))].sort()).toEqual(['A', 'B', 'C', 'D']);
    // A song at a time from each band, so everyone's opener lands first.
    expect(tracks.map((t) => t.title)).toEqual(['A1', 'B1', 'C1', 'D1', 'A2', 'B2']);
  });

  it('does not stall on bands with shorter sets than the rest', () => {
    const bands = [ref('A', [song('A1')]), ref('B', [song('B1'), song('B2'), song('B3')])];
    expect(buildPlaylistTracks(bands, { maxTracks: 3 }).map((t) => t.title))
      .toEqual(['A1', 'B1', 'B2']);
  });
});

describe('concertPerformers', () => {
  const concert = (metadata, bands) => ({ metadata: JSON.stringify(metadata), bands });

  it('puts the whole bill in, not just the bands with a row in the table', () => {
    // The Fållan show: four acts billed, one of them followed.
    const c = concert(
      ['Counterparts', 'thrown', 'No Cure', 'Heavensgate'],
      [ref('THROWN', [song('On the Verge')])],
    );
    const external = new Map([
      ['counterparts', { songs: [song('Bloodbath')] }],
      ['nocure', { songs: [song('Waiting')] }],
      ['heavensgate', { songs: [song('Gate')] }],
    ]);
    expect(concertPerformers(c, external).map((p) => p.band_rel.name))
      .toEqual(['Heavensgate', 'No Cure', 'THROWN', 'Counterparts']);
  });

  it('runs smallest act first, because the stored order is popularity', () => {
    // Bandsintown sorts a lineup by follower count — 58 of 58 stored bills were
    // in strictly descending order — so reversing it approximates stage order.
    const c = concert(['Headliner', 'Support', 'Opener'], []);
    const external = new Map([
      ['headliner', { songs: [song('H')] }],
      ['support', { songs: [song('S')] }],
      ['opener', { songs: [song('O')] }],
    ]);
    expect(concertPerformers(c, external).map((p) => p.band_rel.name))
      .toEqual(['Opener', 'Support', 'Headliner']);
  });

  it('leaves out billed acts nothing could be found for', () => {
    const c = concert(['Known', 'Unfindable'], [ref('Known', [song('K')])]);
    expect(concertPerformers(c, new Map()).map((p) => p.band_rel.name)).toEqual(['Known']);
  });

  it('matches a billed name to its band row through spelling differences', () => {
    const c = concert(['Architects'], [ref('Architects (UK)', [song('Animals')])]);
    const performers = concertPerformers(c, new Map());
    expect(performers).toHaveLength(1);
    // The band row wins, so the concert-specific setlist is still reachable.
    expect(performers[0].band_rel.setlist.songs[0].name).toBe('Animals');
  });

  it('keeps a linked band the lineup text left out', () => {
    const c = concert(['Opener'], [ref('Missing From Bill', [song('M')])]);
    const external = new Map([['opener', { songs: [song('O')] }]]);
    expect(concertPerformers(c, external).map((p) => p.band_rel.name))
      .toEqual(['Opener', 'Missing From Bill']);
  });

  it('falls back to the linked bands when there is no lineup stored', () => {
    const c = { metadata: null, bands: [ref('THROWN', [song('On the Verge')])] };
    expect(concertPerformers(c).map((p) => p.band_rel.name)).toEqual(['THROWN']);
  });
});

describe('unresolvedBillNames', () => {
  it('names the billed acts with no songs anywhere yet', () => {
    const c = {
      metadata: JSON.stringify(['Counterparts', 'thrown', 'No Cure']),
      bands: [ref('THROWN', [song('On the Verge')])],
    };
    expect(unresolvedBillNames(c)).toEqual(['Counterparts', 'No Cure']);
  });

  it('counts a linked band with no setlist as still unresolved', () => {
    const c = {
      metadata: JSON.stringify(['Silent Band']),
      bands: [ref('Silent Band', null)],
    };
    expect(unresolvedBillNames(c)).toEqual(['Silent Band']);
  });

  it('is empty when there is no lineup to resolve', () => {
    expect(unresolvedBillNames({ metadata: null, bands: [] })).toEqual([]);
    expect(unresolvedBillNames({ metadata: 'not json', bands: [] })).toEqual([]);
  });
});

describe('searchQueries', () => {
  it('asks precisely first, then loosely', () => {
    expect(searchQueries({ title: 'On the Verge', artist: 'THROWN' })).toEqual([
      'track:"On the Verge" artist:"THROWN"',
      'On the Verge THROWN',
    ]);
  });

  it('drops quotes that would close the field early', () => {
    expect(searchQueries({ title: 'Say "Hello"', artist: 'Someone' })[0])
      .toBe('track:"Say Hello" artist:"Someone"');
  });

  it('falls back to the title alone when there is no artist', () => {
    expect(searchQueries({ title: 'On the Verge', artist: '' })).toEqual(['On the Verge']);
  });

  it('returns nothing to search for an empty title', () => {
    expect(searchQueries({ title: '', artist: 'THROWN' })).toEqual([]);
  });
});

describe('pickBestTrack', () => {
  const item = (name, ...artists) => ({ name, uri: `spotify:track:${name}`, artists: artists.map((n) => ({ name: n })) });

  it('takes an exact title by the right artist over a higher-ranked edit', () => {
    // This is the failure it exists for: the sped-up edit outranks the album cut.
    const items = [item('On the Verge - Sped Up', 'THROWN'), item('On the Verge', 'THROWN')];
    expect(pickBestTrack(items, { title: 'On the Verge', artist: 'THROWN' }).name).toBe('On the Verge');
  });

  it('prefers the requested artist when several acts have the same song', () => {
    const items = [item('We Are the Champions', 'Karaoke Crew'), item('We Are the Champions', 'Queen')];
    expect(pickBestTrack(items, { title: 'We Are the Champions', artist: 'Queen' }).artists[0].name)
      .toBe('Queen');
  });

  it('ignores a parenthesised suffix when comparing titles', () => {
    const items = [item('Bloodbath (Remastered)', 'Counterparts')];
    expect(pickBestTrack(items, { title: 'Bloodbath', artist: 'Counterparts' })).toBe(items[0]);
  });

  it('falls back to the top hit when nothing matches exactly', () => {
    const items = [item('Something Else', 'Someone')];
    expect(pickBestTrack(items, { title: 'On the Verge', artist: 'THROWN' })).toBe(items[0]);
  });

  it('is null when there were no results', () => {
    expect(pickBestTrack([], { title: 'x', artist: 'y' })).toBe(null);
    expect(pickBestTrack(undefined, { title: 'x', artist: 'y' })).toBe(null);
  });
});

describe('formatConcertDay', () => {
  it('reads the day in UTC', () => {
    // 23:00Z on the 27th is the 28th locally east of UTC and still the 27th
    // west of it. The concert is on the 27th either way.
    expect(formatConcertDay('2026-11-27T23:00:00Z')).toBe('27 Nov 2026');
    expect(formatConcertDay(new Date('2026-11-27T00:30:00Z'))).toBe('27 Nov 2026');
  });

  it('is empty for a missing or unparseable date', () => {
    expect(formatConcertDay(null)).toBe('');
    expect(formatConcertDay('whenever')).toBe('');
  });
});

describe('playlistName', () => {
  it('uses the event name and the day', () => {
    expect(playlistName({ name: 'THROWN @ Fållan', concert_date: '2026-11-27T19:00:00Z' }))
      .toBe('THROWN @ Fållan — 27 Nov 2026');
  });

  it('falls back to venue and city when the concert has no name', () => {
    expect(playlistName({ venue: 'Fållan', city: 'Johanneshov', concert_date: '2026-11-27T19:00:00Z' }))
      .toBe('Fållan, Johanneshov — 27 Nov 2026');
  });

  it('leaves off the dash when there is no date', () => {
    expect(playlistName({ name: 'Resurrection Fest' })).toBe('Resurrection Fest');
    expect(playlistName({})).toBe('Concert');
  });
});

describe('playlistDescription', () => {
  it('says when the running order is a guess', () => {
    const tracks = buildPlaylistTracks([ref('THROWN', [song('On the Verge')])]);
    expect(playlistDescription({ venue: 'Fållan', city: 'Johanneshov' }, tracks))
      .toContain('Based on recent setlists');
  });

  it('says when it is the set that was played', () => {
    const tracks = buildPlaylistTracks([ref('THROWN', [song('Guiding Light')], [song('On the Verge')])]);
    const description = playlistDescription({ venue: 'Fållan' }, tracks);
    expect(description).toContain('as it was played');
    expect(description).toContain('THROWN at Fållan');
  });
});
