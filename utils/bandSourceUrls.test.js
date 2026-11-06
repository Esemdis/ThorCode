import { describe, it, expect, vi, afterEach } from 'vitest';

import { isConfidentNameMatch, findSourceUrls, verifyClaimedMbid, MB_RETRY_ATTEMPTS } from './bandSourceUrls.js';

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

  // The third element exists so the band-create route can store a *vetted*
  // MBID. It used to run its own `artist:"name"` search, take artists[0].id
  // with no name check, save that, and hand it back here — which made this
  // function skip the very guard above, on the one path where a brand-new band
  // is being identified for the first time.
  it('reports the MBID it resolved, so a caller can store a vetted one', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ data: { artists: [{ id: 'right-mbid', name: 'Example Band' }] } })
      .mockResolvedValueOnce(relationsResponse([]));

    const [, , mbid] = await findSourceUrls('Example Band', null, { get });

    expect(mbid).toBe('right-mbid');
  });

  it('reports no MBID when the top match was too different to trust', async () => {
    const get = vi.fn().mockResolvedValue({
      data: { artists: [{ id: 'wrong-mbid', name: 'A Totally Different Band' }] },
    });

    const [, , mbid] = await findSourceUrls('Example Band', null, { get });

    expect(mbid).toBeNull();
  });

  it('reports back the MBID it was given rather than inventing one', async () => {
    const get = vi.fn().mockResolvedValue(relationsResponse([]));

    const [, , mbid] = await findSourceUrls('Example', 'known-mbid', { get });

    expect(mbid).toBe('known-mbid');
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

describe('lucenePhrase', () => {
  it('quotes a name so MusicBrainz searches for all of it', async () => {
    const { lucenePhrase } = await import('./bandSourceUrls.js');
    expect(lucenePhrase('Gojira')).toBe('"Gojira"');
    // A quote ended the phrase early, and a backslash escaped what followed.
    expect(lucenePhrase('The "Band"')).toBe('"The \\"Band\\""');
    expect(lucenePhrase('A\\B')).toBe('"A\\\\B"');
  });
});

describe('verifyClaimedMbid', () => {
  // quick-add stores a client's MBID only when this says MusicBrainz agrees.
  // MBID is unique across every account, so a wrong pairing used to block the
  // real band for everyone (THO-758).
  const tho758Mbid = '65f4f0c5-ef9e-490c-aee3-909e7ae6b2ab';
  const tho758Artist = (name, id = tho758Mbid) => ({ data: { id, name } });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('returns the MBID when MusicBrainz names the same artist', async () => {
    const get = vi.fn().mockResolvedValue(tho758Artist('Gojira'));

    expect(await verifyClaimedMbid('Gojira', tho758Mbid, { get })).toBe(tho758Mbid);
  });

  it('still matches through a country suffix and accents', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(tho758Artist('Architects'))
      .mockResolvedValueOnce(tho758Artist('Sigur Rós'));

    expect(await verifyClaimedMbid('Architects (UK)', tho758Mbid, { get })).toBe(tho758Mbid);
    expect(await verifyClaimedMbid('Sigur Ros', tho758Mbid, { get })).toBe(tho758Mbid);
  });

  it('refuses an MBID that belongs to an unrelated name', async () => {
    const get = vi.fn().mockResolvedValue(tho758Artist('Gojira'));

    expect(await verifyClaimedMbid('Not Gojira At All', tho758Mbid, { get })).toBeNull();
  });

  it('refuses a name with nothing left to compare', async () => {
    // canonicalBandName('!!!') is '' — two empty keys must not count as equal.
    const get = vi.fn().mockResolvedValue(tho758Artist('???'));

    expect(await verifyClaimedMbid('!!!', tho758Mbid, { get })).toBeNull();
  });

  it('refuses an MBID MusicBrainz does not know', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const get = vi.fn().mockRejectedValue(
      Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } }),
    );

    expect(await verifyClaimedMbid('Gojira', tho758Mbid, { get })).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('answers null rather than throwing when MusicBrainz cannot be reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const get = vi.fn().mockRejectedValue(Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' }));

    await expect(verifyClaimedMbid('Gojira', tho758Mbid, { get })).resolves.toBeNull();
  });

  it('retries a busy MusicBrainz and verifies what it eventually answers', async () => {
    vi.useFakeTimers();
    const get = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 503'), { response: { status: 503 } }))
      .mockResolvedValueOnce(tho758Artist('Gojira'));

    const promise = verifyClaimedMbid('Gojira', tho758Mbid, { get });
    await vi.runAllTimersAsync();

    expect(await promise).toBe(tho758Mbid);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('refuses an id that MusicBrainz answers for with a different one', async () => {
    // A merged MBID redirects to the artist it was merged into. That is not
    // the id the client claimed, so it is not stored as if it were.
    const get = vi.fn().mockResolvedValue(tho758Artist('Gojira', 'a6f2c1e2-0000-4000-8000-000000000001'));

    expect(await verifyClaimedMbid('Gojira', tho758Mbid, { get })).toBeNull();
  });

  it('compares the id without regard to case', async () => {
    const get = vi.fn().mockResolvedValue(tho758Artist('Gojira'));
    const upper = tho758Mbid.toUpperCase();

    expect(await verifyClaimedMbid('Gojira', upper, { get })).toBe(upper);
  });

  it('looks the artist up by id and never searches', async () => {
    const get = vi.fn().mockResolvedValue(tho758Artist('Gojira'));

    await verifyClaimedMbid('Gojira', tho758Mbid, { get });

    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe(`https://musicbrainz.org/ws/2/artist/${tho758Mbid}`);
    expect(get.mock.calls[0][1].params).toEqual({ fmt: 'json' });
  });
});
