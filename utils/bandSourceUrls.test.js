import { describe, it, expect, vi } from 'vitest';

import { isConfidentNameMatch, findSourceUrls } from './bandSourceUrls.js';

describe('isConfidentNameMatch', () => {
  it('accepts an exact name', () => {
    expect(isConfidentNameMatch('Architects', 'Architects')).toBe(true);
  });

  it('accepts casing, punctuation and article differences', () => {
    expect(isConfidentNameMatch('Blink 182', 'Blink-182')).toBe(true);
    expect(isConfidentNameMatch('The National', 'National')).toBe(true);
  });

  it('rejects an unrelated band that MusicBrainz returned as its closest match', () => {
    // "architects" once resolved to a much bigger, unrelated act ahead of the
    // actual band on a plain query — this is the case NAME_MATCH_THRESHOLD
    // exists to catch.
    expect(isConfidentNameMatch('Architects', 'Bad Omens')).toBe(false);
  });

  it('rejects when MusicBrainz returned no candidate name', () => {
    expect(isConfidentNameMatch('Architects', '')).toBe(false);
    expect(isConfidentNameMatch('Architects', undefined)).toBe(false);
  });
});

describe('findSourceUrls', () => {
  const relationsResponse = (relations) => ({ data: { relations } });

  it('uses the MBID directly when given one, skipping the search call', async () => {
    const get = vi.fn().mockResolvedValue(
      relationsResponse([
        { url: { resource: 'https://www.songkick.com/artists/123-example?foo=1' } },
        { url: { resource: 'https://www.bandsintown.com/a/456-example/' } },
      ]),
    );

    const [songkick, bandsintown] = await findSourceUrls('Example', 'known-mbid', { get });

    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toContain('known-mbid');
    expect(songkick).toBe('https://www.songkick.com/artists/123-example');
    expect(bandsintown).toBe('https://www.bandsintown.com/a/456-example');
  });

  it('does not trust a search result whose name looks like a different band', async () => {
    const get = vi.fn().mockResolvedValue({
      data: { artists: [{ id: 'wrong-mbid', name: 'A Totally Different Band' }] },
    });

    const [songkick, bandsintown] = await findSourceUrls('Example Band', null, { get });

    // Only the search call happens — the mismatch stops it before the
    // url-rels lookup would have used the wrong id.
    expect(get).toHaveBeenCalledTimes(1);
    expect(songkick).toBeNull();
    expect(bandsintown).toBeNull();
  });

  it('returns nulls without throwing when MusicBrainz has no artist for the name', async () => {
    const get = vi.fn().mockResolvedValue({ data: { artists: [] } });

    const [songkick, bandsintown] = await findSourceUrls('Example Band', null, { get });

    expect(songkick).toBeNull();
    expect(bandsintown).toBeNull();
  });

  it('throws when MusicBrainz cannot be reached, instead of resolving to nulls', async () => {
    const get = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(findSourceUrls('Example', 'known-mbid', { get })).rejects.toThrow('ETIMEDOUT');
  });
});
