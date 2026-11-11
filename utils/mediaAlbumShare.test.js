import { describe, it, expect } from 'vitest';
import {
  ALBUM_TTL_MS, albumExpiry, normaliseAttendanceIds, sameIds, unionIds, albumBase, albumMediaUrls, albumPayload,
  albumNightKey, albumLinkForNight,
} from './mediaAlbumShare.js';

describe('albumExpiry', () => {
  it('gives an album a week, where one file gets twelve hours', () => {
    const now = new Date('2026-11-10T10:00:00Z');
    expect(albumExpiry(now).toISOString()).toBe('2026-11-17T10:00:00.000Z');
    expect(ALBUM_TTL_MS).toBe(7 * 24 * 3600 * 1000);
  });
});

describe('normaliseAttendanceIds', () => {
  it('reads the same night the same way whatever order it was named in', () => {
    expect(normaliseAttendanceIds([7, 3, 7, 5])).toEqual([3, 5, 7]);
    expect(normaliseAttendanceIds('7,3,5')).toEqual([3, 5, 7]);
  });

  it('refuses a list with anything in it that is not an attendance id', () => {
    // Each of these would otherwise round or coerce into a real id.
    for (const bad of [[1.5], ['1abc'], [true], [0], [-1], [null], ['']]) {
      expect(normaliseAttendanceIds(bad)).toBeNull();
    }
  });

  it('refuses no list, an empty one, and one past a 32-bit id', () => {
    expect(normaliseAttendanceIds(undefined)).toBeNull();
    expect(normaliseAttendanceIds([])).toBeNull();
    expect(normaliseAttendanceIds({ 0: 1 })).toBeNull();
    expect(normaliseAttendanceIds([2147483648])).toBeNull();
  });

  it('refuses more attendances than any night has', () => {
    const many = Array.from({ length: 51 }, (_, i) => i + 1);
    expect(normaliseAttendanceIds(many)).toBeNull();
    expect(normaliseAttendanceIds(many.slice(0, 50))).toHaveLength(50);
  });
});

describe('sameIds', () => {
  it('compares two normalised lists', () => {
    expect(sameIds([1, 2], [1, 2])).toBe(true);
    expect(sameIds([1, 2], [1, 2, 3])).toBe(false);
    expect(sameIds([1, 3], [1, 2])).toBe(false);
  });
});

describe('unionIds', () => {
  it('is both lists as one, each id once, ascending', () => {
    expect(unionIds([1, 5], [3, 1])).toEqual([1, 3, 5]);
  });
});

describe('albumNightKey (THO-895)', () => {
  it('reads a night as the UTC calendar day and the city, as the app groups them', () => {
    // 23:30 UTC is still the 12th: the day is sliced from the instant, the
    // way the client slices concert_date, never read through local time.
    expect(albumNightKey({ concert_date: new Date('2026-06-12T23:30:00Z'), city: 'Oslo' })).toBe('2026-06-12|Oslo');
    expect(albumNightKey({ concert_date: '2026-06-12T19:00:00.000Z', city: null })).toBe('2026-06-12|');
  });

  it('puts a show with no date in no night', () => {
    expect(albumNightKey({ concert_date: null, city: 'Oslo' })).toBeNull();
    expect(albumNightKey(undefined)).toBeNull();
  });
});

describe('albumLinkForNight (THO-895)', () => {
  const NIGHT_A_THO895 = '2026-06-12|Oslo';
  const NIGHT_B_THO895 = '2026-06-13|Oslo';
  const nightsTho895 = (entries) => new Map(Object.entries(entries).map(([id, night]) => [Number(id), night]));

  it('widens a link whose attendances and the request\'s are still one night', () => {
    const link = { attendance_ids: [1] };
    expect(albumLinkForNight([link], [1, 2], nightsTho895({ 1: NIGHT_A_THO895, 2: NIGHT_A_THO895 }))).toBe(link);
  });

  it('passes over a link that shares an attendance but has become another night', () => {
    // Night A shared as 1 and 2; 2's date was corrected into night B with 3.
    const nightA = { attendance_ids: [1, 2] };
    const nights = nightsTho895({ 1: NIGHT_A_THO895, 2: NIGHT_B_THO895, 3: NIGHT_B_THO895 });
    expect(albumLinkForNight([nightA], [2, 3], nights)).toBeNull();
    expect(albumLinkForNight([nightA], [2], nights)).toBeNull();
  });

  it('takes the newest link that is this night, past one that is not', () => {
    const stale = { attendance_ids: [1, 2] };
    const nightB = { attendance_ids: [2, 3] };
    const nights = nightsTho895({ 1: NIGHT_A_THO895, 2: NIGHT_B_THO895, 3: NIGHT_B_THO895 });
    expect(albumLinkForNight([stale, nightB], [2, 3], nights)).toBe(nightB);
  });

  it('hands back an exact match whatever the dates say, so asking again never mints another', () => {
    const link = { attendance_ids: [1, 4] };
    expect(albumLinkForNight([link], [1, 4], nightsTho895({ 1: NIGHT_A_THO895, 4: NIGHT_B_THO895 }))).toBe(link);
  });

  it('never widens into or out of a show with no date', () => {
    const link = { attendance_ids: [1] };
    expect(albumLinkForNight([link], [1, 2], nightsTho895({ 1: NIGHT_A_THO895, 2: null }))).toBeNull();
  });

  it('leaves out an attendance on the link that has gone, as reading the album does', () => {
    // 7 is on the link but no longer the owner's: not in the map at all.
    const link = { attendance_ids: [1, 7] };
    expect(albumLinkForNight([link], [1, 2], nightsTho895({ 1: NIGHT_A_THO895, 2: NIGHT_A_THO895 }))).toBe(link);
  });
});

describe('albumBase', () => {
  it('drops a trailing slash from the configured base', () => {
    expect(albumBase('https://api.example.com/')).toBe('https://api.example.com');
  });

  it('throws on a base that would produce a relative URL', () => {
    expect(() => albumBase('')).toThrow(/CALLBACK_URL/);
    expect(() => albumBase('api.example.com')).toThrow(/not absolute/);
    expect(() => albumBase('ftp://api.example.com')).toThrow(/not http/);
  });
});

describe('albumMediaUrls', () => {
  it('builds each copy under the album token', () => {
    expect(albumMediaUrls('https://api.example.com', 'tok', 9)).toEqual({
      thumb: 'https://api.example.com/data/concerts/album-shares/tok/media/9/thumb',
      view: 'https://api.example.com/data/concerts/album-shares/tok/media/9/view',
      file: 'https://api.example.com/data/concerts/album-shares/tok/media/9/file',
    });
  });
});

describe('albumPayload', () => {
  const albumLinkTho892 = { token: 'tok', expires_at: new Date('2026-11-17T10:00:00Z') };
  const albumConcertTho892 = (over = {}) => ({
    concert_date: new Date('2026-06-12T19:00:00Z'), venue: 'Sentrum Scene', city: 'Oslo', country: 'NO',
    bands: [{ setlist: { songs: [{ name: 'Stranded' }] }, band_rel: { id: 92, name: 'Gojira' } }],
    ...over,
  });
  const albumRowTho892 = (over = {}) => ({
    id: 1, attendance_id: 1, band_id: 92, kind: 'VIDEO', filename: 'VID_1.mp4', bytes: 5000,
    width: 3840, height: 2160, duration_ms: 61000, caption: 'Encore', song: 'Stranded',
    taken_at: new Date('2026-06-12T21:00:00Z'),
    rel_path: 'user-1/2026-06-12 Oslo - Gojira/VID_1.mp4', sha256: 'abc', picked: true,
    moment_start_ms: 1, moment_end_ms: 2, created_at: new Date(),
    ...over,
  });
  const build = (attendances, media = [albumRowTho892()]) => albumPayload({
    link: albumLinkTho892, attendances, media, baseUrl: 'https://api.example.com',
  });

  it('tells a stranger nothing of where the file is kept or whose it is', () => {
    // rel_path opens with the owner's user id; the checksum, the recap's pick
    // and the attendance are the account's own business too.
    const [file] = build([{ id: 1, concert_rel: albumConcertTho892() }]).files;
    expect(Object.keys(file).sort()).toEqual([
      'band_id', 'bytes', 'caption', 'duration_ms', 'file', 'filename', 'height', 'id',
      'kind', 'song', 'taken_at', 'thumb', 'view', 'width',
    ]);
    expect(JSON.stringify(build([{ id: 1, concert_rel: albumConcertTho892() }]))).not.toContain('user-1');
  });

  it('describes the night by its date, place and every venue of the day', () => {
    const out = build([
      { id: 1, concert_rel: albumConcertTho892({ venue: 'Main Stage' }) },
      { id: 2, concert_rel: albumConcertTho892({ venue: 'Tent' }) },
      { id: 3, concert_rel: albumConcertTho892({ venue: 'Main Stage' }) },
    ]);
    expect(out.night).toEqual({ date: '2026-06-12', venues: ['Main Stage', 'Tent'], city: 'Oslo', country: 'NO' });
    expect(out.expires_at).toEqual(albumLinkTho892.expires_at);
  });

  it('says no date rather than 1970 for a show that has none', () => {
    const out = build([{ id: 1, concert_rel: albumConcertTho892({ concert_date: null }) }]);
    expect(out.night.date).toBeNull();
  });

  it('lists an act once across stages, with the setlist of whichever stage has one', () => {
    const out = build([
      { id: 1, concert_rel: albumConcertTho892({ bands: [{ setlist: null, band_rel: { id: 92, name: 'Gojira' } }] }) },
      {
        id: 2,
        concert_rel: albumConcertTho892({
          bands: [
            { setlist: { songs: [{ name: 'Stranded' }] }, band_rel: { id: 92, name: 'Gojira' } },
            { setlist: null, band_rel: { id: 7, name: 'Alcest' } },
          ],
        }),
      },
    ]);
    expect(out.bands).toEqual([
      { id: 92, name: 'Gojira', setlist: { songs: [{ name: 'Stranded' }] } },
      { id: 7, name: 'Alcest', setlist: null },
    ]);
  });

  it('names an act a file is filed under though it is on none of the bills, after the bill', () => {
    // Tagged with an act from another stage of the day. Without the name the
    // recipient's page has nothing to head those files with.
    const out = albumPayload({
      link: albumLinkTho892, attendances: [{ id: 1, concert_rel: albumConcertTho892() }],
      media: [albumRowTho892({ band_id: 7 })], otherBands: [{ id: 7, name: 'Alcest' }, { id: 92, name: 'Gojira' }],
      baseUrl: 'https://api.example.com',
    });
    expect(out.bands.map((b) => [b.id, b.name, b.setlist === null])).toEqual([
      [92, 'Gojira', false],
      [7, 'Alcest', true],
    ]);
  });

  it('refuses to build a listing from a base that is not absolute', () => {
    expect(() => albumPayload({
      link: albumLinkTho892, attendances: [{ id: 1, concert_rel: albumConcertTho892() }], media: [], baseUrl: 'api.example.com',
    })).toThrow(/not absolute/);
  });
});
