import { describe, it, expect, vi, afterEach } from 'vitest';

import { isConfidentNameMatch, findSourceUrls, MB_RETRY_ATTEMPTS } from './bandSourceUrls.js';

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

describe('findSourceUrls — MusicBrainz being busy', () => {
  afterEach(() => { vi.useRealTimers(); });

  // MusicBrainz sheds load with a 503 and the body "The MusicBrainz web server
  // is currently busy. Please try again later." Measured against the live API,
  // roughly one request in three came back this way even at well under the
  // documented rate limit — so a single attempt loses the lookup outright, and
  // the band silently keeps its missing urls.
  const busy = (status) => Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { error: 'The MusicBrainz web server is currently busy. Please try again later.' } },
  });

  const relations = { data: { relations: [{ url: { resource: 'https://www.songkick.com/artists/367767' } }] } };

  it('retries a busy response and keeps the urls it eventually gets', async () => {
    vi.useFakeTimers();
    const get = vi.fn()
      .mockRejectedValueOnce(busy(503))
      .mockResolvedValueOnce(relations);

    const promise = findSourceUrls('Example', 'known-mbid', { get });
    await vi.runAllTimersAsync();
    const [songkick] = await promise;

    expect(get).toHaveBeenCalledTimes(2);
    expect(songkick).toBe('https://www.songkick.com/artists/367767');
  });

  it('retries a rate-limit response too', async () => {
    vi.useFakeTimers();
    const get = vi.fn()
      .mockRejectedValueOnce(busy(429))
      .mockResolvedValueOnce(relations);

    const promise = findSourceUrls('Example', 'known-mbid', { get });
    await vi.runAllTimersAsync();
    await promise;

    expect(get).toHaveBeenCalledTimes(2);
  });

  it('gives up after a bounded number of attempts rather than hammering', async () => {
    vi.useFakeTimers();
    const get = vi.fn().mockRejectedValue(busy(503));

    const promise = findSourceUrls('Example', 'known-mbid', { get });
    // Attached before the timers run: an unhandled rejection between the last
    // retry and the assertion would fail the run rather than this expectation.
    const settled = expect(promise).rejects.toThrow(/503/);
    await vi.runAllTimersAsync();
    await settled;

    expect(get).toHaveBeenCalledTimes(MB_RETRY_ATTEMPTS);
  });

  it('does not retry an error that says the request itself was wrong', async () => {
    // A 404 is an answer, not congestion. Retrying it just delays the failure.
    const get = vi.fn().mockRejectedValue(
      Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } }),
    );

    await expect(findSourceUrls('Example', 'known-mbid', { get })).rejects.toThrow('404');
    expect(get).toHaveBeenCalledTimes(1);
  });
});
