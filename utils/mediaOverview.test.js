import { describe, it, expect } from 'vitest';
import { bandMediaOverview } from './mediaOverview.js';

const urlFor = (id) => ({ file: `/f/${id}`, thumb: `/t/${id}` });

const attendance = (id, date, venue = 'Sentrum Scene', city = 'Oslo', bands = [{ id: 92, name: 'Gojira' }]) =>
  ({ id, concert: { id: id * 10, date, venue, city, bands } });

const file = (id, attendance_id, over = {}) =>
  ({ id, attendance_id, band_id: 92, filename: `IMG_${id}.jpg`, kind: 'PHOTO',
     caption: '', width: 4080, height: 3072, duration_ms: null,
     taken_at: '2026-06-12T21:14:09', sha256: `h${id}`, ...over });

describe('bandMediaOverview stats', () => {
  it('counts files and videos separately', () => {
    const { stats } = bandMediaOverview({
      attendances: [attendance(1, '2026-06-12')],
      media: [file(1, 1), file(2, 1, { kind: 'VIDEO', duration_ms: 24000 })],
      urlFor,
    });
    expect(stats.files).toBe(2);
    expect(stats.videos).toBe(1);
  });

  it('reports shots against shows, not shots against shots', () => {
    // "7 of 9 shows" is the number that tells you what you missed. The
    // denominator is every show of this band you attended, shot or not.
    const { stats } = bandMediaOverview({
      attendances: [attendance(1, '2026-06-12'), attendance(2, '2025-08-03'), attendance(3, '2024-11-19')],
      media: [file(1, 1), file(2, 1), file(3, 3)],
      urlFor,
    });
    expect(stats.shows_with_media).toBe(2);
    expect(stats.shows_attended).toBe(3);
  });

  it('spans the years of the shows, not the years of the uploads', () => {
    // Importing a 2019 photo today must not make the span say 2026 to 2026.
    const { stats } = bandMediaOverview({
      attendances: [attendance(1, '2026-06-12'), attendance(2, '2019-03-01')],
      media: [file(1, 1), file(2, 2)],
      urlFor,
    });
    expect(stats.first_year).toBe(2019);
    expect(stats.last_year).toBe(2026);
  });

  it('gives a count for every year in the span, including the empty ones', () => {
    // The sparkline is a shape. Omitting a year with nothing in it would draw
    // a gap as though it were adjacent, which misreads as a steady run.
    const { stats } = bandMediaOverview({
      attendances: [attendance(1, '2026-06-12'), attendance(2, '2024-11-19')],
      media: [file(1, 1), file(2, 2), file(3, 2)],
      urlFor,
    });
    expect(stats.per_year).toEqual([
      { year: 2024, count: 2 }, { year: 2025, count: 0 }, { year: 2026, count: 1 },
    ]);
  });

  it('reports zeroes rather than nulls for a band you have shot nothing of', () => {
    const { stats } = bandMediaOverview({
      attendances: [attendance(1, '2026-06-12')], media: [], urlFor,
    });
    expect(stats).toMatchObject({
      files: 0, videos: 0, shows_with_media: 0, shows_attended: 1,
      first_year: null, last_year: null, per_year: [],
    });
  });
});

describe('bandMediaOverview rail', () => {
  it('lists every show attended, newest first', () => {
    const { rail } = bandMediaOverview({
      attendances: [attendance(2, '2024-11-19'), attendance(1, '2026-06-12')],
      media: [file(1, 1)],
      urlFor,
    });
    expect(rail.map((r) => r.date)).toEqual(['2026-06-12', '2024-11-19']);
  });

  it('includes a show attended with nothing shot, at a count of zero', () => {
    // "I was there and shot nothing" is real information, and the layout greys
    // that row out rather than hiding it.
    const { rail } = bandMediaOverview({
      attendances: [attendance(1, '2026-06-12'), attendance(2, '2023-02-08')],
      media: [file(1, 1)],
      urlFor,
    });
    expect(rail.find((r) => r.date === '2023-02-08').count).toBe(0);
  });

  it('carries the venue and city, so the rail reads without another request', () => {
    const { rail } = bandMediaOverview({
      attendances: [attendance(1, '2026-06-12', 'Rockefeller', 'Oslo')], media: [], urlFor,
    });
    expect(rail[0]).toMatchObject({ venue: 'Rockefeller', city: 'Oslo', attendance_id: 1 });
  });

  it('carries that night\'s bill, which the client needs twice', () => {
    // The lightbox band picker and the upload dialog both offer exactly the
    // bands that played. Sending the bill with the rail is what keeps either of
    // them from costing a second request.
    const bill = [{ id: 92, name: 'Gojira' }, { id: 7, name: 'Alcest' }];
    const { rail } = bandMediaOverview({
      attendances: [attendance(1, '2026-06-12', 'Rockefeller', 'Oslo', bill)], media: [], urlFor,
    });
    expect(rail[0].bands).toEqual(bill);
  });
});

describe('bandMediaOverview files', () => {
  it('attaches the signed URLs so the client builds no paths of its own', () => {
    const { files } = bandMediaOverview({
      attendances: [attendance(1, '2026-06-12')], media: [file(5, 1)], urlFor,
    });
    expect(files[0]).toMatchObject({ id: 5, file: '/f/5', thumb: '/t/5' });
  });

  it('orders by the show date, newest first, so the grid matches the rail', () => {
    const { files } = bandMediaOverview({
      attendances: [attendance(1, '2026-06-12'), attendance(2, '2024-11-19')],
      media: [file(1, 2), file(2, 1)],
      urlFor,
    });
    expect(files.map((f) => f.id)).toEqual([2, 1]);
  });

  it('tags each file with the show it came from, for the year rule in the grid', () => {
    const { files } = bandMediaOverview({
      attendances: [attendance(1, '2026-06-12')], media: [file(1, 1)], urlFor,
    });
    expect(files[0]).toMatchObject({ concert_date: '2026-06-12', venue: 'Sentrum Scene' });
  });

  it('drops a file whose attendance is not in the list rather than crashing', () => {
    // Defensive: the two queries are not in one transaction, so an attendance
    // removed between them would otherwise throw on a null lookup.
    const { files } = bandMediaOverview({
      attendances: [attendance(1, '2026-06-12')], media: [file(1, 1), file(2, 99)], urlFor,
    });
    expect(files.map((f) => f.id)).toEqual([1]);
  });
});
