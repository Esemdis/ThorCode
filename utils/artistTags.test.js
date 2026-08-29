import { describe, it, expect } from 'vitest';
import { shapeArtistInfo, cleanTags } from './artistTags.js';

const payload = (over = {}) => ({
  artist: {
    name: 'Spiritbox',
    url: 'https://www.last.fm/music/Spiritbox',
    stats: { listeners: '598931', playcount: '49924385' },
    tags: { tag: [{ name: 'metalcore' }, { name: 'DJENT' }, { name: 'Progressive Metalcore' }] },
    ...over,
  },
});

describe('cleanTags', () => {
  it('drops the tag that is just the band name', () => {
    // Last.fm's top tag for Metallica is "metallica". Rendered as a genre chip
    // it tells you the name of the band whose name you are looking at.
    expect(cleanTags(['metallica', 'heavy metal', 'thrash'], 'Metallica', 2)).toEqual(['heavy metal', 'thrash']);
  });

  it('matches the band name past punctuation and case', () => {
    expect(cleanTags(['blink 182', 'pop punk'], 'blink-182', 2)).toEqual(['pop punk']);
  });

  it('lowercases tags, because Last.fm tags are raw user input', () => {
    // They arrive as DJENT, Progressive Metalcore, idm — inconsistent casing
    // that reads as broken next to each other. Lowercase matches the
    // convention the dropdown was already built around.
    expect(cleanTags(['DJENT', 'Progressive Metalcore'], 'Spiritbox', 2)).toEqual(['djent', 'progressive metalcore']);
  });

  it('caps the list at the limit', () => {
    expect(cleanTags(['a', 'b', 'c', 'd'], 'Band', 2)).toEqual(['a', 'b']);
  });

  it('removes duplicates left behind by lowercasing', () => {
    expect(cleanTags(['Metalcore', 'metalcore', 'djent'], 'Band', 2)).toEqual(['metalcore', 'djent']);
  });

  it('is empty for an artist with no tags at all', () => {
    expect(cleanTags([], 'Band', 2)).toEqual([]);
    expect(cleanTags(null, 'Band', 2)).toEqual([]);
  });
});

describe('shapeArtistInfo', () => {
  it('returns the tags, listener count and Last.fm url', () => {
    expect(shapeArtistInfo(payload(), 'Spiritbox')).toEqual({
      tags: ['metalcore', 'djent'],
      listeners: 598931,
      lastfmUrl: 'https://www.last.fm/music/Spiritbox',
    });
  });

  it('returns null when Last.fm says it has never heard of the artist', () => {
    // Error 6 is the not-found case and arrives as a 200 with an error body,
    // not as an HTTP failure.
    expect(shapeArtistInfo({ error: 6, message: 'The artist you supplied could not be found' }, 'Nobody')).toBeNull();
  });

  it('returns null when autocorrect resolved to a different band', () => {
    // autocorrect=1 fixes real typos, but Ticketmaster names are rarely
    // misspelled — so a corrected name usually means Last.fm reached for a
    // different artist, and showing its genres is the exact mistake the
    // Spotify matcher was built to avoid.
    expect(shapeArtistInfo(payload({ name: 'Spirit Box Tribute' }), 'Spiritbox')).toBeNull();
  });

  it('accepts a correction that is only punctuation or case', () => {
    expect(shapeArtistInfo(payload({ name: 'blink-182' }), 'Blink 182')).not.toBeNull();
  });

  it('survives an artist with no stats or tags', () => {
    expect(shapeArtistInfo({ artist: { name: 'Spiritbox' } }, 'Spiritbox')).toEqual({
      tags: [], listeners: null, lastfmUrl: null,
    });
  });

  it('returns null for a response with no artist at all', () => {
    expect(shapeArtistInfo({}, 'Spiritbox')).toBeNull();
    expect(shapeArtistInfo(null, 'Spiritbox')).toBeNull();
  });
});
