import { describe, it, expect } from 'vitest';
import { setlistSummary } from './setlistSummary.js';

describe('setlistSummary', () => {
  it('counts only performed songs, leaving out the walk-on tape', () => {
    const setlist = {
      url: 'https://www.setlist.fm/setlist/gojira/2026/vega-63de4613.html',
      songs: [
        { name: 'Intro', tape: true },
        { name: 'Stranded', tape: false },
        { name: 'Flying Whales' },
        { name: 'Amazonia', cover: null, tape: false },
        { name: 'Outro', tape: true },
      ],
    };

    expect(setlistSummary(setlist)).toEqual({
      setlist_songs: 3,
      setlist_url: 'https://www.setlist.fm/setlist/gojira/2026/vega-63de4613.html',
    });
  });

  it('says no songs and no link when there is no setlist', () => {
    const none = { setlist_songs: 0, setlist_url: null };
    expect(setlistSummary(null)).toEqual(none);
    expect(setlistSummary(undefined)).toEqual(none);
    // Malformed blobs from before the shape settled: a songs field that is not
    // a list, a null entry, an empty url. None of them may throw on a list read.
    expect(setlistSummary({ songs: 'Stranded' })).toEqual(none);
    expect(setlistSummary({ songs: [null], url: '' })).toEqual(none);
    expect(setlistSummary('not a setlist')).toEqual(none);
  });
});
