import { describe, it, expect } from 'vitest';
import {
  isSetlistId, isMbid, setlistSummary, setlistDate,
} from './setlistFm.js';

describe('isSetlistId', () => {
  it('accepts setlist.fm ids', () => {
    expect(isSetlistId('63de4613')).toBe(true);
    expect(isSetlistId('3bd6bc5c')).toBe(true);
  });

  it('refuses anything that could change the URL path it goes into', () => {
    // Pasted into /setlist/<id> with the server's API key on the request.
    for (const bad of ['../artist/x', '63de4613?p=2', '63de4613/..', 'a b', '', '%2e%2e', null, ['63de4613']]) {
      expect(isSetlistId(bad)).toBe(false);
    }
  });
});

describe('isMbid', () => {
  it('accepts a MusicBrainz id and nothing else', () => {
    expect(isMbid('65f4f0c5-ef9e-490c-aee3-909e7ae6b2ab')).toBe(true);
    expect(isMbid('65f4f0c5-ef9e-490c-aee3-909e7ae6b2ab/../x')).toBe(false);
    expect(isMbid('not-an-mbid')).toBe(false);
    expect(isMbid(null)).toBe(false);
  });
});

describe('setlistDate', () => {
  it('reads setlist.fm\'s dd-MM-yyyy as noon UTC on that day', () => {
    expect(setlistDate('24-06-2026')?.toISOString()).toBe('2026-06-24T12:00:00.000Z');
  });

  it('refuses a date that does not exist rather than rolling it over', () => {
    expect(setlistDate('31-02-2026')).toBe(null);
    expect(setlistDate('2026-06-24')).toBe(null);
    expect(setlistDate(undefined)).toBe(null);
  });
});

describe('setlistSummary', () => {
  it('flattens a setlist into the shape the app reads', () => {
    const summary = setlistSummary({
      id: '63de4613',
      eventDate: '24-06-2026',
      url: 'https://www.setlist.fm/setlist/x.html',
      tour: { name: 'Fortitude' },
      venue: {
        name: 'Fållan',
        city: { name: 'Stockholm', country: { code: 'SE' }, coords: { lat: 59.33, long: 18.06 } },
      },
      sets: { set: [
        { song: [{ name: 'Intro', tape: true }, { name: 'Stranded' }] },
        { encore: 1, song: [{ name: 'Where Is My Mind?', cover: { name: 'Pixies' } }, {}] },
      ] },
    });

    expect(summary).toEqual({
      setlistfm_id: '63de4613',
      date: '24-06-2026',
      venue: 'Fållan',
      city: 'Stockholm',
      country: 'SE',
      latitude: 59.33,
      longitude: 18.06,
      tour: 'Fortitude',
      url: 'https://www.setlist.fm/setlist/x.html',
      songs: [
        { name: 'Intro', cover: null, tape: true },
        { name: 'Stranded', cover: null, tape: false },
        { name: 'Where Is My Mind?', cover: 'Pixies', tape: false },
        { name: '', cover: null, tape: false },
      ],
    });
  });

  it('survives a setlist with nothing but an id', () => {
    expect(setlistSummary({ id: 'abc' })).toMatchObject({ setlistfm_id: 'abc', venue: null, songs: [] });
  });
});
