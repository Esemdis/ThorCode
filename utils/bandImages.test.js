import { describe, it, expect, vi } from 'vitest';
import {
  IMAGE_TTL_SECONDS,
  exactArtistMatch,
  pickArtistImage,
  imageCacheKey,
  resolveArtistImages,
} from './bandImages.js';

const artist = (name, images = []) => ({ id: name.toLowerCase(), name, images });

describe('exactArtistMatch', () => {
  it('takes the artist whose name is the band name, not the one Spotify ranked first', () => {
    const artists = [artist('Architects UK'), artist('Architects')];
    expect(exactArtistMatch(artists, 'Architects').name).toBe('Architects');
  });

  it('ignores punctuation, spacing and case when comparing', () => {
    expect(exactArtistMatch([artist('Blink-182')], 'blink 182').name).toBe('Blink-182');
  });

  // The whole point of storing an id is that it is permanent, so a near miss
  // must fail rather than pin the wrong band's photo to a row forever. This is
  // deliberately stricter than relevantArtists, which may fall back to
  // Spotify's best guess.
  it('returns null when only a partial name matches', () => {
    expect(exactArtistMatch([artist('Architects of Chaos')], 'Architects')).toBeNull();
  });

  it('returns null for an empty result set or an empty name', () => {
    expect(exactArtistMatch([], 'Architects')).toBeNull();
    expect(exactArtistMatch([artist('Architects')], '')).toBeNull();
  });
});

describe('pickArtistImage', () => {
  it('takes the smallest image still large enough for a retina avatar', () => {
    const images = [{ url: 'big', width: 640 }, { url: 'mid', width: 320 }, { url: 'thumb', width: 120 }];
    expect(pickArtistImage({ images })).toBe('mid');
  });

  it('keeps an image that is exactly at the threshold', () => {
    expect(pickArtistImage({ images: [{ url: 'big', width: 640 }, { url: 'edge', width: 160 }] })).toBe('edge');
  });

  it('falls back to the largest available when every image is too small', () => {
    expect(pickArtistImage({ images: [{ url: 'a', width: 64 }, { url: 'b', width: 120 }] })).toBe('b');
  });

  // Spotify omits width on some artist images rather than sending zero.
  it('does not discard an image just because it has no width', () => {
    expect(pickArtistImage({ images: [{ url: 'only' }] })).toBe('only');
  });

  it('returns null for an artist with no images', () => {
    expect(pickArtistImage({ images: [] })).toBeNull();
    expect(pickArtistImage(null)).toBeNull();
  });
});

describe('resolveArtistImages', () => {
  const deps = (cached = {}, fetched = []) => ({
    getCache: vi.fn(async (key) => cached[key] ?? null),
    setCache: vi.fn(async () => {}),
    getArtists: vi.fn(async () => fetched),
  });

  it('returns the cached url without asking Spotify', async () => {
    const d = deps({ [imageCacheKey('abc')]: { url: 'cached.jpg' } });
    expect(await resolveArtistImages(['abc'], d)).toEqual({ abc: 'cached.jpg' });
    expect(d.getArtists).not.toHaveBeenCalled();
  });

  it('fetches only the ids that missed the cache', async () => {
    const d = deps(
      { [imageCacheKey('abc')]: { url: 'cached.jpg' } },
      [{ id: 'def', images: [{ url: 'fresh.jpg', width: 320 }] }],
    );
    expect(await resolveArtistImages(['abc', 'def'], d)).toEqual({ abc: 'cached.jpg', def: 'fresh.jpg' });
    expect(d.getArtists).toHaveBeenCalledWith(['def']);
  });

  // Spotify's terms allow caching an image for at most 24 hours, and their CDN
  // urls rotate, so a longer ttl would eventually serve a dead link.
  it('caches a fetched url for under a day', async () => {
    const d = deps({}, [{ id: 'def', images: [{ url: 'fresh.jpg', width: 320 }] }]);
    await resolveArtistImages(['def'], d);
    expect(d.setCache).toHaveBeenCalledWith(imageCacheKey('def'), { url: 'fresh.jpg' }, IMAGE_TTL_SECONDS);
    expect(IMAGE_TTL_SECONDS).toBeLessThan(24 * 60 * 60);
  });

  // Wrapped in an object for the same reason the Last.fm cache is: a bare null
  // cannot be told apart from a miss, and an artist with no photo would be
  // re-fetched on every request forever.
  it('caches the absence of a photo so it is not looked up again', async () => {
    const d = deps({}, [{ id: 'def', images: [] }]);
    expect(await resolveArtistImages(['def'], d)).toEqual({});
    expect(d.setCache).toHaveBeenCalledWith(imageCacheKey('def'), { url: null }, IMAGE_TTL_SECONDS);
  });

  it('treats a cached absence as an answer, not a miss', async () => {
    const d = deps({ [imageCacheKey('abc')]: { url: null } });
    expect(await resolveArtistImages(['abc'], d)).toEqual({});
    expect(d.getArtists).not.toHaveBeenCalled();
  });

  it('has nothing to do when no band has been matched to Spotify', async () => {
    const d = deps();
    expect(await resolveArtistImages([null, undefined, ''], d)).toEqual({});
    expect(d.getArtists).not.toHaveBeenCalled();
  });

  it('asks for each id once even when several bands share one', async () => {
    const d = deps({}, [{ id: 'abc', images: [{ url: 'x.jpg', width: 320 }] }]);
    await resolveArtistImages(['abc', 'abc'], d);
    expect(d.getArtists).toHaveBeenCalledWith(['abc']);
  });

  // The overview lists every band there is, and each id costs its own request
  // because Spotify's batch endpoint is 403 for a Development Mode app. The
  // window keeps that a series of short bursts rather than one flood.
  it('looks the ids up in bounded groups rather than all at once', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `id${i}`);
    const d = deps({}, []);
    await resolveArtistImages(ids, d);
    expect(d.getArtists.mock.calls.map(([batch]) => batch.length)).toEqual([10, 10, 5]);
  });

  // The band overview passes cacheOnly: a list endpoint must never wait on
  // Spotify, because a cold cache would otherwise fan out one request per band
  // on the request path and blow the client's timeout.
  it('serves what the cache has and skips Spotify entirely when cacheOnly', async () => {
    const d = deps({ [imageCacheKey('abc')]: { url: 'cached.jpg' } });
    const out = await resolveArtistImages(['abc', 'def'], d, { cacheOnly: true });

    expect(out).toEqual({ abc: 'cached.jpg' });
    expect(d.getArtists).not.toHaveBeenCalled();
  });

  it('writes nothing to the cache when it is only reading it', async () => {
    const d = deps();
    await resolveArtistImages(['abc'], d, { cacheOnly: true });

    expect(d.setCache).not.toHaveBeenCalled();
  });

  // An overview that renders monograms is fine; one that 500s is not.
  it('degrades to no images when Spotify fails', async () => {
    const d = deps({}, []);
    d.getArtists = vi.fn(async () => { throw new Error('502'); });
    expect(await resolveArtistImages(['abc'], d)).toEqual({});
  });
});
