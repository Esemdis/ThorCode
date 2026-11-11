import { describe, it, expect } from 'vitest';
import {
  ALBUM_TTL_MS, albumExpiry, normaliseAttendanceIds, sameIds, unionIds, albumBase, albumMediaUrls, albumPayload,
  parsePicksOnly, albumMediaWhere, albumServesFile,
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

// Sharing a night's picks rather than every file of it (THO-849).
describe('parsePicksOnly', () => {
  it('reads a JSON boolean and the text a query string carries', () => {
    expect(parsePicksOnly(true)).toBe(true);
    expect(parsePicksOnly('1')).toBe(true);
    expect(parsePicksOnly('true')).toBe(true);
    expect(parsePicksOnly(false)).toBe(false);
    expect(parsePicksOnly('0')).toBe(false);
    expect(parsePicksOnly('false')).toBe(false);
  });

  it('tells not given apart from given as something it cannot read', () => {
    // Not given is each route's default; anything else is refused, never
    // guessed: a typo must not share the whole night when the picks were meant.
    expect(parsePicksOnly(undefined)).toBeUndefined();
    for (const bad of [null, 'yes', 'TRUE', 1, 0, '', ['1'], {}]) expect(parsePicksOnly(bad)).toBeNull();
  });
});

describe('albumMediaWhere', () => {
  it('asks for every file of the attendances for a whole-night link', () => {
    expect(albumMediaWhere({ picks_only: false }, [1, 2])).toEqual({ attendance_id: { in: [1, 2] } });
    // A row from before the column existed reads as a whole-night link.
    expect(albumMediaWhere({}, [1])).toEqual({ attendance_id: { in: [1] } });
  });

  it('asks only for the picked ones for a picks link', () => {
    expect(albumMediaWhere({ picks_only: true }, [1, 2])).toEqual({ attendance_id: { in: [1, 2] }, picked: true });
  });
});

describe('albumServesFile', () => {
  const picksLinkTho849 = { user_id: 'user-1', attendance_ids: [1, 2], picks_only: true };
  const rowTho849 = (over = {}) => ({
    attendance_id: 1, picked: true, attendance_rel: { wishlist_rel: { user_id: 'user-1' } }, ...over,
  });

  it('opens a picked file of the night for a picks link, and not an unpicked one', () => {
    // The ids are sequential: an unpicked file is one guess away from a picked
    // one, so the byte route asks the same question the listing does.
    expect(albumServesFile(picksLinkTho849, rowTho849())).toBe(true);
    expect(albumServesFile(picksLinkTho849, rowTho849({ picked: false }))).toBe(false);
  });

  it('opens every file of the night for a whole-night link', () => {
    expect(albumServesFile({ ...picksLinkTho849, picks_only: false }, rowTho849({ picked: false }))).toBe(true);
  });

  it('never opens a file from another night or another account, picked or not', () => {
    expect(albumServesFile(picksLinkTho849, rowTho849({ attendance_id: 3 }))).toBe(false);
    expect(albumServesFile(picksLinkTho849, rowTho849({ attendance_rel: { wishlist_rel: { user_id: 'someone-else' } } })))
      .toBe(false);
    expect(albumServesFile(picksLinkTho849, null)).toBe(false);
  });
});

describe('albumPayload for a picks link', () => {
  const picksConcertTho849 = {
    concert_date: new Date('2026-06-12T19:00:00Z'), venue: 'Sentrum Scene', city: 'Oslo', country: 'NO',
    bands: [{ setlist: { songs: [{ name: 'Stranded' }] }, band_rel: { id: 92, name: 'Gojira' } }],
  };
  const buildPicksTho849 = (link, attendance = { id: 1, concert_rel: picksConcertTho849 }) => albumPayload({
    link: { token: 'tok', expires_at: new Date('2026-11-17T10:00:00Z'), ...link },
    attendances: [attendance],
    media: [],
    baseUrl: 'https://api.example.com',
  });

  it('says whether it is the picks or the whole night', () => {
    expect(buildPicksTho849({ picks_only: true }).picks_only).toBe(true);
    expect(buildPicksTho849({ picks_only: false }).picks_only).toBe(false);
    expect(buildPicksTho849({}).picks_only).toBe(false);
  });

  it('keeps the bill and the setlist, and leaves the owner\'s notes and other people out', () => {
    // An attendance row carries the owner's diary (notes, rating) and the
    // wishlist it hangs off; none of it is the recipient's to read.
    const out = buildPicksTho849({ picks_only: true }, {
      id: 1,
      notes: 'went with Kari, lost my jacket',
      rating: 5,
      wishlist_rel: { user_id: 'user-1', name: 'Mine' },
      concert_rel: { ...picksConcertTho849, attendances: [{ wishlist_rel: { user_id: 'user-2' } }] },
    });
    expect(Object.keys(out).sort()).toEqual(['bands', 'expires_at', 'files', 'night', 'picks_only']);
    expect(out.bands).toEqual([{ id: 92, name: 'Gojira', setlist: { songs: [{ name: 'Stranded' }] } }]);
    const text = JSON.stringify(out);
    for (const secret of ['Kari', 'jacket', 'rating', 'user-1', 'user-2', 'Mine']) expect(text).not.toContain(secret);
  });
});
