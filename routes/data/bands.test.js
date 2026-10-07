import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildApp, authHeader, installFakePrisma, routeManifest } from '../../test/routeApp.js';

// Seeded before the router is imported — see installFakePrisma for why this
// is a global rather than a vi.mock.
const prisma = installFakePrisma({
  band: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  concert: {
    findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(),
    create: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
  },
  city: { upsert: vi.fn(), update: vi.fn() },
  wishlist: { findUnique: vi.fn(), findFirst: vi.fn() },
  wishlistBandReference: { findMany: vi.fn(), create: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn() },
  concertBandReference: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  concertAttendance: { findMany: vi.fn(), deleteMany: vi.fn() },
  concertMedia: { findMany: vi.fn(), deleteMany: vi.fn() },
  activityLog: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []), deleteMany: vi.fn() },
  // /bands answers with raw SQL rather than the query builder.
  $queryRaw: vi.fn(async () => []),
  // /bulk's per-concert savepoints. Recorded as the statement text, so a test
  // can read the order they ran in.
  $executeRaw: vi.fn(async (strings) => { prisma.statements.push(strings.join('?')); return 0; }),
  statements: [],
  // The array form ($transaction([...])) resolves an already-built list of
  // query promises; the interactive form ($transaction(async tx => ...)) runs
  // its callback against the fake client itself, same as the real client runs
  // it against a scoped one.
  $transaction: vi.fn(async (arg) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
});

const { default: router } = await import('./bands.js');
const app = buildApp(router);

beforeEach(() => { vi.clearAllMocks(); });

describe('GET /bands/search', () => {
  it('answers a one-character query with an empty list, without touching the database', async () => {
    const res = await request(app).get('/bands/search').query({ q: 'a' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(prisma.band.findMany).not.toHaveBeenCalled();
  });

  it('puts prefix matches above the rest', async () => {
    prisma.band.findMany.mockResolvedValue([
      { id: 2, name: 'Bring Me The Horizon' },
      { id: 1, name: 'Horizon' },
    ]);
    const res = await request(app).get('/bands/search').query({ q: 'hori' });
    expect(res.status).toBe(200);
    expect(res.body.map((b) => b.name)).toEqual(['Horizon', 'Bring Me The Horizon']);
  });
});

describe('POST /bands', () => {
  // Only the paths that answer before the MusicBrainz lookup are covered here.
  // The lookup itself is unit-tested in utils/bandSourceUrls.test.js with an
  // injected client: vi.mock does not reach a CommonJS `require`, so a route
  // test that got as far as findSourceUrls would make a real network call.
  it('refuses a request with no name rather than creating an unnamed band', async () => {
    const res = await request(app).post('/bands').set(...authHeader()).send({});

    expect(res.status).toBe(400);
    expect(prisma.band.create).not.toHaveBeenCalled();
  });

  it('reports an existing band as a conflict without looking anything up', async () => {
    // The name is the unique key, so this is the ordinary "already added" case
    // rather than an error — and it must not spend a MusicBrainz call on a band
    // whose urls were resolved when it was first added.
    prisma.band.findUnique.mockResolvedValue({ id: 5, name: 'Architects' });

    const res = await request(app).post('/bands').set(...authHeader()).send({ name: 'Architects' });

    expect(res.status).toBe(409);
    expect(prisma.band.create).not.toHaveBeenCalled();
  });

  it('names the band it is stored as when MusicBrainz says the two are one artist', async () => {
    // The router's own copy of band creation: CommonJS, loaded through Node's
    // require, which an ESM import does not share.
    const bandCreate = createRequire(import.meta.url)('../../utils/bandCreate.js');
    vi.spyOn(bandCreate, 'createBand').mockRejectedValue(new bandCreate.BandExistsError({ id: 4, name: 'Architects' }));

    const res = await request(app).post('/bands').set(...authHeader()).send({ name: 'Architects (UK)' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Band already exists as "Architects".', band: { id: 4, name: 'Architects' } });
  });

  it('trims the name before deciding whether the band already exists', async () => {
    prisma.band.findUnique.mockResolvedValue({ id: 5, name: 'Architects' });

    await request(app).post('/bands').set(...authHeader()).send({ name: '  Architects  ' });

    expect(prisma.band.findUnique).toHaveBeenCalledWith({ where: { name: 'Architects' } });
  });

  it('refuses a name that is only whitespace', async () => {
    // notEmpty() passed "   ", the handler trimmed it to "", and a band with
    // no name went into the table every account reads.
    const res = await request(app).post('/bands').set(...authHeader()).send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(prisma.band.findUnique).not.toHaveBeenCalled();
    expect(prisma.band.create).not.toHaveBeenCalled();
  });
});

describe('POST /bands/quick-add', () => {
  const MBID = '65f4f0c5-ef9e-490c-aee3-909e7ae6b2ab';

  beforeEach(() => {
    prisma.band.findFirst = vi.fn(async () => null);
    prisma.band.create = vi.fn(async ({ data }) => ({ id: 50, name: data.name }));
    prisma.concert.findMany.mockResolvedValue([]);
  });

  it('uses the band already stored under that name when its MBID is not on file', async () => {
    // Looked up by MBID alone, this missed, and creating the band again hit
    // the unique name as a 500.
    prisma.band.findFirst = vi.fn(async ({ where }) => (where.name === 'Gojira' ? { id: 92, name: 'Gojira' } : null));

    const res = await request(app).post('/bands/quick-add').set(...authHeader()).send({ name: 'Gojira', mbid: MBID });

    expect(res.status).toBe(201);
    expect(res.body.band).toEqual({ id: 92, name: 'Gojira' });
    expect(prisma.band.create).not.toHaveBeenCalled();
  });

  it('takes the band someone else created a moment ago', async () => {
    let created = false;
    prisma.band.findFirst = vi.fn(async ({ where }) => (created && where.name === 'Gojira' ? { id: 93, name: 'Gojira' } : null));
    prisma.band.create = vi.fn(async () => { created = true; throw Object.assign(new Error('unique'), { code: 'P2002' }); });

    const res = await request(app).post('/bands/quick-add').set(...authHeader()).send({ name: 'Gojira' });

    expect(res.status).toBe(201);
    expect(res.body.band.id).toBe(93);
  });

  it('refuses an MBID that is not one', async () => {
    const res = await request(app).post('/bands/quick-add').set(...authHeader()).send({ name: 'Gojira', mbid: '../../x' });

    expect(res.status).toBe(400);
    expect(prisma.band.create).not.toHaveBeenCalled();
  });
});

describe('GET /bands/search input', () => {
  it('clamps a limit that is not a number instead of passing NaN to Prisma', async () => {
    prisma.band.findMany.mockResolvedValue([]);

    const res = await request(app).get('/bands/search').query({ q: 'gojira', limit: 'abc' });

    expect(res.status).toBe(200);
    expect(prisma.band.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10 }));
  });

  it('caps a large limit', async () => {
    prisma.band.findMany.mockResolvedValue([]);

    await request(app).get('/bands/search').query({ q: 'gojira', limit: '100000' });

    expect(prisma.band.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
  });

  it('answers an empty list for a repeated q rather than throwing on it', async () => {
    const res = await request(app).get('/bands/search?q=ab&q=cd');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('GET /setlist-lookup', () => {
  it('refuses an id that would steer the request elsewhere on setlist.fm', async () => {
    // The id went into the URL path unescaped, with the server's API key on
    // the request.
    for (const id of ['../artist/65f4f0c5-ef9e-490c-aee3-909e7ae6b2ab/setlists', '63de4613?p=2']) {
      const res = await request(app).get('/setlist-lookup').query({ id }).set(...authHeader());
      expect(res.status).toBe(400);
    }
  });
});

describe('POST /bulk', () => {
  // Every concert runs inside one interactive transaction, and a failing
  // statement in Postgres aborts the transaction rather than just itself. The
  // loop caught each concert's error and carried on — so after one bad row
  // every later statement was refused, the COMMIT silently became a ROLLBACK,
  // and the response still said "inserted N". Reproduced against Postgres with
  // one band listed twice on one concert: inserted 1 reported, 0 rows saved.
  const system = { id: 'scraper', role: 'SYSTEM' };
  const concert = (venue, bands = [{ band_id: 1 }]) => ({
    country: 'SE', city: 'Stockholm', venue, concert_date: '2027-05-01T19:00:00Z', bands,
  });

  beforeEach(() => {
    prisma.statements.length = 0;
    prisma.band.findMany.mockResolvedValue([{ id: 1, name: 'Gojira' }]);
    prisma.band.findUnique.mockImplementation(async ({ where }) => ({ id: where.id, name: `Band ${where.id}` }));
    prisma.concert.findMany.mockResolvedValue([]);
    prisma.city.upsert.mockResolvedValue({ id: 7 });
    let nextId = 100;
    prisma.concert.create.mockImplementation(async ({ data }) => ({ id: nextId++, ...data }));
    prisma.concertBandReference.createMany.mockResolvedValue({ count: 1 });
  });

  describe('the city a show is in', () => {
    const placed = (over = {}) => ({
      ...concert('Annexet'), latitude: '59.2937', longitude: '18.0810', ...over,
    });

    it('fills in coordinates a stored city has none of', async () => {
      prisma.city.upsert.mockResolvedValue({ id: 7, latitude: null, longitude: null });

      const res = await request(app)
        .post('/bulk').set(...authHeader(system)).send({ concerts: [placed()] });

      expect(res.status).toBe(200);
      expect(prisma.city.update).toHaveBeenCalledWith({
        where: { id: 7 }, data: { latitude: 59.2937, longitude: 18.0810 },
      });
    });

    it('leaves a city that already has a point where it is', async () => {
      // Every ingest used to write the scraped venue's position onto the city,
      // so two rooms across town kept moving it between them.
      prisma.city.upsert.mockResolvedValue({ id: 7, latitude: 59.3293, longitude: 18.0686 });

      const res = await request(app)
        .post('/bulk').set(...authHeader(system)).send({ concerts: [placed()] });

      expect(res.status).toBe(200);
      expect(prisma.city.update).not.toHaveBeenCalled();
      expect(prisma.city.upsert.mock.calls[0][0].update).toEqual({});
    });
  });

  it('gives each concert a savepoint, and rolls back only the one that failed', async () => {
    prisma.concert.create
      .mockImplementationOnce(async ({ data }) => ({ id: 100, ...data }))
      .mockImplementationOnce(async () => { throw Object.assign(new Error('unique violation'), { code: 'P2002' }); })
      .mockImplementationOnce(async ({ data }) => ({ id: 102, ...data }));

    const res = await request(app)
      .post('/bulk')
      .set(...authHeader(system))
      .send({ concerts: [concert('Fållan'), concert('Nalen'), concert('Kollektivet')] });

    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(2);
    expect(res.body.errors).toBe(1);
    expect(res.body.details.errors).toEqual([{ index: 1, message: 'unique violation' }]);
    expect(res.body.details.insertedConcerts.map((c) => c.venue)).toEqual(['Fållan', 'Kollektivet']);
    expect(prisma.statements).toEqual([
      'SAVEPOINT bulk_concert', 'RELEASE SAVEPOINT bulk_concert',
      'SAVEPOINT bulk_concert', 'ROLLBACK TO SAVEPOINT bulk_concert', 'RELEASE SAVEPOINT bulk_concert',
      'SAVEPOINT bulk_concert', 'RELEASE SAVEPOINT bulk_concert',
    ]);
  });

  it('does not report a concert whose later statement failed', async () => {
    // The concert row went in; linking its bands did not. Rolled back, so it
    // must not be listed as inserted either.
    prisma.concertBandReference.createMany.mockRejectedValueOnce(new Error('link failed'));

    const res = await request(app)
      .post('/bulk')
      .set(...authHeader(system))
      .send({ concerts: [concert('Fållan')] });

    expect(res.body.inserted).toBe(0);
    expect(res.body.details.insertedConcerts).toEqual([]);
    expect(prisma.statements).toContain('ROLLBACK TO SAVEPOINT bulk_concert');
  });

  describe('a show it already has, by event id', () => {
    // A postponed or moved show keeps its event id, and kept its old date and
    // venue here: only prices, sale state and sold-out were ever updated, and
    // reconcile matches it by event id and looks no further.
    const stored = (over = {}) => ({
      id: 55, event_id: 'bit_1', name: 'Gojira', venue: 'Annexet', city: 'Stockholm', country: 'SE',
      concert_date: new Date('2030-05-01T19:00:00Z'), latitude: '59.2936', longitude: '18.0836',
      sold_out: false, _count: { bands: 1 }, ...over,
    });
    const again = (over = {}) => ({ ...concert('Annexet'), event_id: 'bit_1', ...over });
    const ingest = async (incoming) => request(app).post('/bulk').set(...authHeader(system)).send({ concerts: [incoming] });
    const written = () => prisma.concert.update.mock.calls.map(([{ data }]) => data);

    beforeEach(() => {
      prisma.concertBandReference.findMany.mockResolvedValue([{ band: 1 }]);
      prisma.concert.update.mockResolvedValue({});
    });

    it('moves a show still to come to its new date', async () => {
      prisma.concert.findUnique.mockResolvedValue(stored());

      const res = await ingest(again({ concert_date: '2030-09-12T19:00:00Z' }));

      expect(res.body.updated).toBe(1);
      expect(written()[0].concert_date).toEqual(new Date('2030-09-12T19:00:00Z'));
    });

    it('takes a start time for the same day, and keeps one it has over a bare date', async () => {
      prisma.concert.findUnique.mockResolvedValue(stored({ concert_date: new Date('2030-05-01T00:00:00Z') }));
      await ingest(again({ concert_date: '2030-05-01T19:30:00Z' }));
      expect(written()[0].concert_date).toEqual(new Date('2030-05-01T19:30:00Z'));

      prisma.concert.update.mockClear();
      prisma.concert.findUnique.mockResolvedValue(stored());
      await ingest(again({ concert_date: '2030-05-01T00:00:00Z' }));
      expect(written().every((data) => !('concert_date' in data))).toBe(true);
    });

    it('never moves a night already been to, nor a show into the past', async () => {
      prisma.concert.findUnique.mockResolvedValue(stored({ concert_date: new Date('2020-05-01T19:00:00Z') }));
      await ingest(again({ concert_date: '2030-09-12T19:00:00Z', venue: 'Avicii Arena', latitude: '59.2936', longitude: '18.0836' }));
      expect(written().every((data) => !('concert_date' in data) && !('venue' in data))).toBe(true);

      prisma.concert.findUnique.mockResolvedValue(stored());
      await ingest(again({ concert_date: '2021-09-12T19:00:00Z' }));
      expect(written().every((data) => !('concert_date' in data))).toBe(true);
    });

    it('moves a show to a new venue across town, with its position', async () => {
      prisma.concert.findUnique.mockResolvedValue(stored());

      await ingest(again({ venue: 'Cirkus', latitude: '59.3247', longitude: '18.0991' }));

      expect(written()[0]).toMatchObject({ venue: 'Cirkus', latitude: '59.3247', longitude: '18.0991' });
    });

    it('keeps a wishlist\'s feed to its fifteen entries when a show sells out', async () => {
      // Sold-out entries were written straight to the table, past logActivity,
      // so they were the one kind that never let the oldest fall off the end.
      prisma.concert.findUnique.mockResolvedValue(stored());
      prisma.concertBandReference.findMany
        .mockResolvedValueOnce([{ band: 1 }])
        .mockResolvedValueOnce([{ band_rel: { name: 'Gojira', wishlists: [{ wishlist_id: 7 }] } }]);
      prisma.activityLog.findMany.mockResolvedValue([{ id: 1 }]);

      await ingest(again({ sold_out: true }));

      expect(prisma.activityLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ wishlist_id: 7, type: 'SOLD_OUT' }),
      });
      expect(prisma.activityLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { wishlist_id: 7 }, skip: 15,
      }));
      expect(prisma.activityLog.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [1] } } });
    });

    it('hands back a show still owed its notification, so the scraper can send it again', async () => {
      // The scraper used to announce only what it had just inserted, so a
      // notification that failed to go out was never tried again.
      const sameNight = { concert_date: '2030-05-01T19:00:00Z' };
      prisma.concert.findUnique.mockResolvedValue(stored({ notify_pending: true }));
      const unchanged = await ingest(again(sameNight));
      const repriced = await ingest(again({ ...sameNight, price_min: 450 }));
      prisma.concert.findUnique.mockResolvedValue(stored());
      const settled = await ingest(again(sameNight));

      expect(unchanged.body.details.duplicateConcerts[0].notifyPending).toBe(true);
      expect(repriced.body.details.updatedConcerts[0].notifyPending).toBe(true);
      expect(settled.body.details.duplicateConcerts[0]).not.toHaveProperty('notifyPending');
    });

    it('keeps its venue for another name at the same place, or one with no position', async () => {
      // Bandsintown files a festival's acts under the grounds and under each
      // stage. The same spot under another name is not a move.
      prisma.concert.findUnique.mockResolvedValue(stored());
      await ingest(again({ venue: 'Annexet Main Stage', latitude: '59.2937', longitude: '18.0837' }));
      await ingest(again({ venue: 'Somewhere Else' }));

      expect(written().every((data) => !('venue' in data))).toBe(true);
    });
  });

  it('flags what it inserts as owed a notification only when the sync will send one', async () => {
    // A manual sync or a single band's stays quiet. Flagged anyway, its shows
    // would be announced by the next scheduled sync instead.
    await request(app).post('/bulk').set(...authHeader(system)).send({ concerts: [concert('Fållan')], notify: true });
    await request(app).post('/bulk').set(...authHeader(system)).send({ concerts: [concert('Nalen')] });
    await request(app).post('/bulk').set(...authHeader(system)).send({ concerts: [concert('Kollektivet')], notify: 'yes' });

    expect(prisma.concert.create.mock.calls.map(([{ data }]) => data.notify_pending)).toEqual([true, false, false]);
  });

  it('links a band listed twice once, rather than tripping the unique key', async () => {
    const res = await request(app)
      .post('/bulk')
      .set(...authHeader(system))
      .send({ concerts: [concert('Fållan', [{ band_id: 1 }, { band_id: 1 }])] });

    expect(res.body.inserted).toBe(1);
    expect(prisma.concertBandReference.createMany).toHaveBeenCalledWith({
      data: [{ concert: 100, band: 1, notify_pending: false }],
      skipDuplicates: true,
    });
  });

  it('flags the acts on a show it inserts only when the sync will announce them', async () => {
    await request(app).post('/bulk').set(...authHeader(system)).send({ concerts: [concert('Fållan')], notify: true });
    await request(app).post('/bulk').set(...authHeader(system)).send({ concerts: [concert('Nalen')] });

    expect(prisma.concertBandReference.createMany.mock.calls.map(([{ data }]) => data[0].notify_pending))
      .toEqual([true, false]);
  });

  describe('an act joining a show it already has', () => {
    // A festival is one row its acts join one scrape at a time. Each act after
    // the first came back as a duplicate, which the scraper never announces,
    // so a festival watch heard of the first act and none of the rest.
    beforeEach(() => {
      prisma.concert.update.mockResolvedValue({});
      prisma.concertBandReference.findMany.mockResolvedValue([]);
    });

    it('by event id: flags the act and the show, and hands the show back as owed', async () => {
      prisma.concert.findUnique.mockResolvedValue({
        id: 55, event_id: 'sk_1', name: 'Copenhell 2027', venue: 'Refshaleøen', city: 'Copenhagen', country: 'DK',
        concert_date: new Date('2027-06-17T00:00:00Z'), sold_out: false, notify_pending: false, _count: { bands: 1 },
      });
      const incoming = {
        ...concert('Refshaleøen', [{ band_id: 2 }]), city: 'Copenhagen', country: 'DK',
        concert_date: '2027-06-17T00:00:00Z', event_id: 'sk_1', name: 'Copenhell 2027',
      };

      const res = await request(app).post('/bulk').set(...authHeader(system)).send({ concerts: [incoming], notify: true });

      expect(prisma.concertBandReference.createMany).toHaveBeenCalledWith({
        data: [{ concert: 55, band: 2, notify_pending: true }], skipDuplicates: true,
      });
      expect(prisma.concert.update).toHaveBeenCalledWith({
        where: { id: 55 }, data: expect.objectContaining({ notify_pending: true }),
      });
      expect(res.body.details.updatedConcerts[0].notifyPending).toBe(true);
    });

    it('merged into a festival row: flags the act and says which scraped show it was', async () => {
      // Bandsintown lists each act at a festival as its own event, so the
      // second act's show has an event id of its own and is matched by name.
      prisma.concert.findMany.mockResolvedValue([{
        id: 77, event_id: 'bit_9', name: 'Opeth @ Copenhell', venue: 'Copenhell', city: 'Copenhagen', country: 'DK',
        concert_date: new Date('2027-06-17T00:00:00Z'), latitude: '55.69', longitude: '12.61',
        festival: false, source: 'bandsintown', notify_pending: false,
        bands: [{ band: 1, band_rel: { name: 'Opeth' } }],
      }]);
      const incoming = {
        country: 'DK', city: 'Copenhagen', venue: 'Copenhell', concert_date: '2027-06-17T00:00:00Z',
        latitude: '55.69', longitude: '12.61', event_id: 'bit_10', name: 'Gojira @ Copenhell',
        source: 'bandsintown', bands: [{ band_id: 2 }],
      };

      const res = await request(app).post('/bulk').set(...authHeader(system)).send({ concerts: [incoming], notify: true });

      expect(res.body.inserted).toBe(0);
      expect(prisma.concertBandReference.createMany).toHaveBeenCalledWith({
        data: [{ concert: 77, band: 2, notify_pending: true }], skipDuplicates: true,
      });
      expect(prisma.concert.update).toHaveBeenCalledWith({ where: { id: 77 }, data: { notify_pending: true } });
      expect(res.body.details.duplicateConcerts[0]).toMatchObject({
        concertId: 77, event_id: 'bit_9', incoming_event_id: 'bit_10', notifyPending: true,
      });
    });

    it('stays quiet for a sync that will not announce it', async () => {
      prisma.concert.findMany.mockResolvedValue([{
        id: 77, event_id: 'bit_9', name: 'Opeth @ Copenhell', venue: 'Copenhell', city: 'Copenhagen', country: 'DK',
        concert_date: new Date('2027-06-17T00:00:00Z'), latitude: '55.69', longitude: '12.61',
        festival: false, source: 'bandsintown', notify_pending: false,
        bands: [{ band: 1, band_rel: { name: 'Opeth' } }],
      }]);
      const incoming = {
        country: 'DK', city: 'Copenhagen', venue: 'Copenhell', concert_date: '2027-06-17T00:00:00Z',
        latitude: '55.69', longitude: '12.61', event_id: 'bit_10', name: 'Gojira @ Copenhell',
        source: 'bandsintown', bands: [{ band_id: 2 }],
      };

      const res = await request(app).post('/bulk').set(...authHeader(system)).send({ concerts: [incoming] });

      expect(prisma.concertBandReference.createMany).toHaveBeenCalledWith({
        data: [{ concert: 77, band: 2, notify_pending: false }], skipDuplicates: true,
      });
      expect(prisma.concert.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: { notify_pending: true } }));
      expect(res.body.details.duplicateConcerts[0]).not.toHaveProperty('notifyPending');
    });
  });

  describe('a scrape of a show it already has by event id', () => {
    // This branch wrote the scrape's ticket fields and bill straight onto the
    // row, so it had neither of the safeguards the duplicate path grew: a
    // source's default "in stock" overwrote a sale day, and the bill was read
    // for bands to link and then dropped.
    const row = (over = {}) => ({
      id: 55, event_id: 'sk_1', name: 'Ghost @ Annexet', venue: 'Annexet', city: 'Stockholm', country: 'SE',
      concert_date: new Date('2027-05-01T19:00:00Z'), latitude: null, longitude: null,
      on_sale: false, sold_out: false, ticket_sale_start: null, metadata: null, notify_pending: false,
      _count: { bands: 1 }, ...over,
    });
    const send = (over) => request(app).post('/bulk').set(...authHeader(system))
      .send({ concerts: [{ ...concert('Annexet'), event_id: 'sk_1', ...over }] });

    beforeEach(() => {
      prisma.concert.update.mockResolvedValue({});
      // The one band is already on the bill, so nothing here is about links.
      prisma.concertBandReference.findMany.mockResolvedValue([{ band: 1 }]);
    });

    it('lets a bare "in stock" neither clear a sale day nor contradict it', async () => {
      // Songkick and Bandsintown both mark a listing in stock by default. Taken
      // at its word, that fired "on sale now" to every follower of the show
      // months before the sale opened.
      prisma.concert.findUnique.mockResolvedValue(row({ ticket_sale_start: new Date('2099-10-09T00:00:00Z') }));

      const res = await send({ on_sale: true, sold_out: false });

      expect(prisma.concert.update).not.toHaveBeenCalled();
      expect(res.body.details.duplicateConcerts[0]).toMatchObject({ concertId: 55 });
    });

    it('records a sell-out, and hands the show back as newly sold out once', async () => {
      prisma.concert.findUnique.mockResolvedValue(row({ on_sale: true }));

      const res = await send({ sold_out: true, on_sale: true });

      expect(prisma.concert.update).toHaveBeenCalledWith({
        where: { id: 55 }, data: { sold_out: true, on_sale: false },
      });
      expect(res.body.newlySoldOut).toHaveLength(1);
    });

    it('stores the bill when the scrape saw more of it, cleaned', async () => {
      prisma.concert.findUnique.mockResolvedValue(row({ metadata: '["Ghost"]' }));

      await send({ metadata: '["Ghost","Hexvessel11.2K Followers"]' });

      expect(prisma.concert.update).toHaveBeenCalledWith({
        where: { id: 55 }, data: { metadata: '["Ghost","Hexvessel"]' },
      });
    });

    it('keeps the bill it has when the scrape saw less of it', async () => {
      prisma.concert.findUnique.mockResolvedValue(row({ metadata: '["Ghost","Hexvessel","Tribulation"]' }));

      await send({ metadata: '["Ghost"]' });

      expect(prisma.concert.update).not.toHaveBeenCalled();
    });
  });
});

describe('POST /:concertId/enrich-lineup', () => {
  // The lineup pass links a festival's acts from its event page. An act linked
  // here first finds itself already on the bill when its own scrape comes in,
  // so this is the one chance to announce it.
  const enrich = (body) => request(app).post('/77/enrich-lineup')
    .set(...authHeader({ id: 'scraper', role: 'SYSTEM' })).send(body);

  beforeEach(() => {
    prisma.band.findMany.mockResolvedValue([{ id: 1, name: 'Opeth' }, { id: 2, name: 'Gojira' }]);
    prisma.concertBandReference.findMany.mockResolvedValue([{ band: 1 }]);
    prisma.concertBandReference.createMany.mockResolvedValue({ count: 1 });
    prisma.concert.update.mockResolvedValue({});
  });

  it('flags the acts it links when the scheduled sync will announce them', async () => {
    const res = await enrich({ band_names: ['Opeth', 'Gojira'], notify: true });

    expect(res.body.linked).toBe(1);
    expect(prisma.concertBandReference.createMany).toHaveBeenCalledWith({
      data: [{ concert: 77, band: 2, notify_pending: true }], skipDuplicates: true,
    });
    expect(prisma.concert.update).toHaveBeenCalledWith({
      where: { id: 77 }, data: expect.objectContaining({ notify_pending: true }),
    });
  });

  it('stays quiet for any other caller', async () => {
    await enrich({ band_names: ['Opeth', 'Gojira'] });

    expect(prisma.concertBandReference.createMany).toHaveBeenCalledWith({
      data: [{ concert: 77, band: 2, notify_pending: false }], skipDuplicates: true,
    });
    expect(prisma.concert.update.mock.calls[0][0].data).not.toHaveProperty('notify_pending');
  });
});

/**
 * The full routing surface of this file, in registration order.
 *
 * This exists to make splitting bands.js safe. It is not a description of good
 * design — it is a fingerprint. Moving a route to another module is fine as
 * long as the aggregate router still presents exactly this, and if it does not,
 * this test names the route that went missing rather than leaving it to be
 * found in production.
 *
 * The trailing count is how many handlers sit on the route, so a lost `auth` or
 * `roleCheck` fails here too.
 */
const EXPECTED_ROUTES = [
  'POST /bulk [4]',
  'GET /bands/search [1]',
  'GET /upcoming/bands [1]',
  'GET /bands [1]',
  'POST /bands/:bandId/sync-concerts [4]',
  'POST /bands/:bandId/reconcile [3]',
  'POST /bands [6]',
  'POST /bands/quick-add [2]',
  // auth + artistLookupRateLimit + handler. This route used to be reachable
  // with no token at all, and it calls matchBandToSpotify — a write plus a
  // Spotify quota burn — so it was an unauthenticated, unmetered proxy.
  'GET /bands/:bandId/upcoming [3]',
  'GET /bands/:bandId/related [2]',
  'POST /bands/:bandId/refresh-urls [3]',
  'PATCH /bands/:bandId [5]',
  'DELETE /bands/:bandId [3]',
  // Same treatment as /upcoming below, and for the same reason: it reaches
  // Last.fm and Spotify on the caller's behalf.
  'GET /bands/artist-search [3]',
  'POST /bands/sync-spotify-ids [3]',
  'POST /bands/sync-photos [3]',
  'POST /bands/sync-all [3]',
  'POST /sync-weather [3]',
  'POST /bands/sync-setlists [3]',
  'GET /bandsintown/enrich-pending [3]',
  'GET /weather-pending [3]',
  'GET /bands/setlist-pending [3]',
  'PATCH /bands/setlists/bulk [3]',
  'DELETE /concerts/:concertId [3]',
  'POST /:concertId/enrich-lineup [3]',
  // auth + setlistFmLimit + handler: both spend the server's setlist.fm key.
  'GET /bands/:bandId/setlist-history [3]',
  'GET /setlist-lookup [3]',
];

describe('the setlist.fm routes', () => {
  // They spend the server's own setlist.fm key, which every account shares
  // and which setlist.fm caps per day. With no limit, one account — or one
  // runaway loop — could spend it for everyone.
  it('stop one account at its budget without stopping anyone else', async () => {
    const require = createRequire(import.meta.url);
    const setlistFm = require('../../utils/setlistFm.js');
    vi.spyOn(setlistFm, 'fetchSetlistById').mockResolvedValue({ id: '63de4613', artist: {} });
    prisma.band.findFirst.mockResolvedValue(null);
    const lookup = (user) => request(app).get('/setlist-lookup').query({ id: '63de4613' }).set(...authHeader({ id: user }));

    for (let i = 0; i < 100; i++) {
      // eslint-disable-next-line no-await-in-loop
      expect((await lookup('greedy')).status).toBe(200);
    }

    expect((await lookup('greedy')).status).toBe(429);
    expect((await lookup('someone-else')).status).toBe(200);
  });
});

describe('the routing surface', () => {
  it('registers exactly the routes it did before, in the same order', () => {
    expect(routeManifest(router)).toEqual(EXPECTED_ROUTES);
  });
});

describe('adding a band to a wishlist that is not yours', () => {
  // wishlistId arrived in the request body and went straight into
  // wishlist_id. Wishlist.user_id is unique — one wishlist per account — and
  // ids are sequential autoincrement ints, so counting up from 1 planted a
  // band on every account in the system. routes/data/wishlists/notify.js then fans
  // that band's new concerts out to the victim's Discord webhook.
  beforeEach(() => {
    prisma.band.findFirst = vi.fn(async () => ({ id: 92, name: 'Gojira' }));
    prisma.wishlist.findFirst = vi.fn(async () => null);
    prisma.wishlistBandReference.upsert = vi.fn(async () => ({}));
    prisma.wishlistBandReference.create = vi.fn(async () => ({}));
  });

  it('refuses quick-add against a stranger\'s wishlist', async () => {
    const res = await request(app)
      .post('/bands/quick-add')
      .set(...authHeader({ id: 'user-1', role: 'USER' }))
      .send({ name: 'Gojira', wishlistId: 3, tier: 'LOVE' });

    expect(res.status).toBe(403);
    expect(prisma.wishlistBandReference.upsert).not.toHaveBeenCalled();
  });

  it('refuses the full create route against a stranger\'s wishlist too', async () => {
    const res = await request(app)
      .post('/bands')
      .set(...authHeader({ id: 'user-1', role: 'USER' }))
      .send({ name: 'Gojira', wishlistId: 3 });

    expect(res.status).toBe(403);
    expect(prisma.wishlistBandReference.create).not.toHaveBeenCalled();
  });

  it('checks the wishlist against the caller, not merely that it exists', async () => {
    await request(app)
      .post('/bands/quick-add')
      .set(...authHeader({ id: 'user-1', role: 'USER' }))
      .send({ name: 'Gojira', wishlistId: 3 });

    expect(prisma.wishlist.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 3, user_id: 'user-1' }),
    }));
  });

  it('still adds to your own wishlist', async () => {
    prisma.wishlist.findFirst = vi.fn(async () => ({ id: 3 }));

    const res = await request(app)
      .post('/bands/quick-add')
      .set(...authHeader({ id: 'user-1', role: 'USER' }))
      .send({ name: 'Gojira', wishlistId: 3, tier: 'LOVE' });

    expect(res.status).toBe(201);
    expect(prisma.wishlistBandReference.upsert).toHaveBeenCalled();
  });

  it('still creates a band when no wishlist is named at all', async () => {
    const res = await request(app)
      .post('/bands/quick-add')
      .set(...authHeader({ id: 'user-1', role: 'USER' }))
      .send({ name: 'Gojira' });

    expect(res.status).toBe(201);
    expect(prisma.wishlist.findFirst).not.toHaveBeenCalled();
  });
});

describe('auth', () => {
  it('turns away an unauthenticated write', async () => {
    const res = await request(app).post('/bands/quick-add').send({ name: 'Opeth' });
    expect(res.status).toBe(401);
  });

  it('turns away a non-admin on an admin job', async () => {
    const res = await request(app).post('/bands/sync-all').set(...authHeader({ role: 'USER' }));
    expect(res.status).toBe(403);
  });

  it('lets an ordinary user search without a token at all', async () => {
    prisma.band.findMany.mockResolvedValue([]);
    const res = await request(app).get('/bands/search').query({ q: 'opeth' });
    expect(res.status).toBe(200);
  });
});

describe('the handlers actually run', () => {
  // The manifest proves a route is registered; it does not prove the handler
  // can execute. Splitting wishlists.js dropped a top-level helper and left two
  // endpoints returning 500 with every routing and auth test still green. These
  // exercise the bodies of the reads the frontend depends on.
  beforeEach(() => {
    prisma.band.findMany.mockResolvedValue([
      { id: 1, name: 'Opeth', songkick_url: 'sk', bandsintown_url: 'bit', concerts: [] },
    ]);
    prisma.band.findUnique.mockResolvedValue({ id: 1, name: 'Opeth', concerts: [] });
    prisma.concert.findMany.mockResolvedValue([]);
    prisma.concertBandReference.findMany.mockResolvedValue([]);
  });

  it('serves the upcoming-bands list', async () => {
    const res = await request(app).get('/upcoming/bands');
    expect(res.status).toBe(200);
  });

  it('serves the band list', async () => {
    const res = await request(app).get('/bands');
    expect(res.status).toBe(200);
  });

  it('serves one band\'s upcoming shows to a signed-in caller', async () => {
    const res = await request(app).get('/bands/1/upcoming').set(...authHeader({ id: 'user-1' }));
    expect(res.status).toBe(200);
  });

  it('turns away an unauthenticated caller, who would otherwise spend our Spotify quota', async () => {
    // The handler calls matchBandToSpotify, which writes to the band row and
    // burns a third-party request. Open to the world that is a free proxy.
    const res = await request(app).get('/bands/1/upcoming');
    expect(res.status).toBe(401);
  });
});

// Three sites detach media before deleting the ConcertAttendance rows that
// gate it. All three once passed the CONCERT id into detachAttendances, which
// reads and deletes ConcertMedia by ATTENDANCE id — both autoincrement ints in
// the same table space, so the bug either detached nothing (then the Restrict
// key rolled the whole transaction back on any orphan with real attendance)
// or, on an id collision, renamed an unrelated user's show folder into
// _detached and deleted their media rows. Each test below asserts the actual
// argument shape passed to concertMedia.findMany, with the concert id and the
// attendance id deliberately different numbers so a regression cannot pass by
// coincidence.
describe('DELETE /concerts/:concertId', () => {
  beforeEach(() => {
    prisma.concert.findUnique.mockResolvedValue({ id: 55 });
    prisma.concertAttendance.findMany.mockResolvedValue([{ id: 501 }]);
    prisma.concertMedia.findMany.mockResolvedValue([]);
    prisma.concertBandReference.deleteMany.mockResolvedValue({ count: 0 });
    prisma.concertAttendance.deleteMany.mockResolvedValue({ count: 1 });
    prisma.concert.delete.mockResolvedValue({ id: 55 });
  });

  it('detaches media by this concert\'s attendance ids, not the concert id, before the rows go', async () => {
    const res = await request(app).delete('/concerts/55').set(...authHeader({ role: 'ADMIN' }));

    expect(res.status).toBe(200);
    expect(prisma.concertAttendance.findMany).toHaveBeenCalledWith({
      where: { concert_id: 55 },
      select: { id: true },
    });
    // Names the attendance id (501), not the concert id (55) — the swap this
    // guards against would have made this [55] instead.
    expect(prisma.concertMedia.findMany).toHaveBeenCalledWith({
      where: { attendance_id: { in: [501] } },
      select: { rel_path: true },
    });
    // Order matters: deleting the index before every folder move has
    // succeeded is not recoverable. See utils/mediaDetach.js.
    const mediaCallOrder = prisma.concertMedia.findMany.mock.invocationCallOrder[0];
    const deleteCallOrder = prisma.concertAttendance.deleteMany.mock.invocationCallOrder[0];
    expect(mediaCallOrder).toBeLessThan(deleteCallOrder);
  });
});

// The folder renames a detach performs are the one part of these transactions
// Postgres cannot roll back. The rows coming back while the folders stay in
// _detached is the worst of the three outcomes and was the silent one: the
// rebuild skips _detached by design, so it reports no drift at all.
describe('DELETE /concerts/:concertId — when the delete fails after the folders moved', () => {
  let root;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'detach-route-'));
    process.env.MEDIA_ROOT = root;
    const show = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    await mkdir(show, { recursive: true });
    await writeFile(join(show, 'a.jpg'), 'x');

    prisma.concert.findUnique.mockResolvedValue({ id: 55 });
    prisma.concertAttendance.findMany.mockResolvedValue([{ id: 501 }]);
    // Two shapes: the rows being detached, then the strangers check.
    prisma.concertMedia.findMany.mockImplementation(async ({ where }) => (
      where.attendance_id.in
        ? [{ rel_path: 'user-1/2026-06-12 Oslo - Gojira/a.jpg' }]
        : []
    ));
    prisma.concertMedia.deleteMany.mockResolvedValue({ count: 1 });
    prisma.concertBandReference.deleteMany.mockResolvedValue({ count: 0 });
    prisma.concertAttendance.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('puts the show folder back where it was', async () => {
    prisma.concert.delete.mockRejectedValue(new Error('deadlock detected'));

    const res = await request(app).delete('/concerts/55').set(...authHeader({ role: 'ADMIN' }));
    expect(res.status).toBeGreaterThanOrEqual(500);

    const show = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    expect(await readdir(show)).toContain('a.jpg');
    expect(await readdir(join(root, 'archive', 'user-1', '_detached'))).toEqual([]);
  });

  it('leaves the folder detached when the delete succeeds, which is the whole point', async () => {
    // The undo must be reachable only from the failure path. A compensating
    // action that also fires on success would undo the feature.
    prisma.concert.delete.mockResolvedValue({ id: 55 });

    const res = await request(app).delete('/concerts/55').set(...authHeader({ role: 'ADMIN' }));
    expect(res.status).toBe(200);

    expect(await readdir(join(root, 'archive', 'user-1', '_detached')))
      .toContain('2026-06-12 Oslo - Gojira');
  });
});

describe('DELETE /bands/:bandId', () => {
  beforeEach(() => {
    prisma.band.findUnique.mockResolvedValue({ id: 9, concerts: [{ concert: 700 }] });
    prisma.wishlistBandReference.deleteMany.mockResolvedValue({ count: 0 });
    prisma.concertBandReference.deleteMany.mockResolvedValue({ count: 1 });
    prisma.band.delete.mockResolvedValue({ id: 9 });
    prisma.concert.findMany.mockResolvedValue([{ id: 700 }]); // the orphan left with zero bands
    prisma.concertAttendance.findMany.mockResolvedValue([{ id: 901 }]);
    prisma.concertMedia.findMany.mockResolvedValue([]);
    prisma.concertAttendance.deleteMany.mockResolvedValue({ count: 1 });
    prisma.concert.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('looks up media by the attendance ids behind an orphaned concert, not the concert id itself', async () => {
    const res = await request(app).delete('/bands/9').set(...authHeader({ role: 'ADMIN' }));

    expect(res.status).toBe(200);
    expect(prisma.concertAttendance.findMany).toHaveBeenCalledWith({
      where: { concert_id: { in: [700] } },
      select: { id: true },
    });
    // Names the attendance id (901), not the orphaned concert id (700).
    expect(prisma.concertMedia.findMany).toHaveBeenCalledWith({
      where: { attendance_id: { in: [901] } },
      select: { rel_path: true },
    });
  });

  it('only sweeps concerts nobody attended', async () => {
    // The sweep used to ask for band-less concerts and nothing else, so a gig
    // someone had been to was swept as debris the moment deleting a band left it
    // without one — the attendance, the concert and every media row gone, the
    // folder in _detached, and the rebuild unable to put it back because it
    // skips _detached and that sidecar names a concert_id that no longer exists.
    await request(app).delete('/bands/9').set(...authHeader({ role: 'ADMIN' }));

    expect(prisma.concert.findMany).toHaveBeenCalledWith({
      where: { id: { in: [700] }, bands: { none: {} }, attendances: { none: {} } },
      select: { id: true },
    });
  });

  it('leaves an attended gig and its photographs entirely alone', async () => {
    // What the query above buys: nothing is detached, nothing is deleted, and
    // the night survives band-less rather than not at all.
    prisma.concert.findMany.mockResolvedValue([]);

    const res = await request(app).delete('/bands/9').set(...authHeader({ role: 'ADMIN' }));

    expect(res.status).toBe(200);
    // Nothing detached: media is only ever read by band here, never by the
    // attendances a detach would move.
    expect(prisma.concertMedia.findMany).not.toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ attendance_id: expect.anything() }),
    }));
    expect(prisma.concertMedia.deleteMany).not.toHaveBeenCalled();
    expect(prisma.concertAttendance.deleteMany).not.toHaveBeenCalled();
    expect(prisma.concert.deleteMany).not.toHaveBeenCalled();
  });

  it('takes the band off its files, in the rows and in the sidecars', async () => {
    // The key SET NULLs band_id on the rows but left the song, and could not
    // reach the sidecars — so the next rebuild wrote the dead id back and had
    // every such file refused by the foreign key.
    const root = await mkdtemp(join(tmpdir(), 'band-untag-'));
    process.env.MEDIA_ROOT = root;
    const show = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    await mkdir(show, { recursive: true });
    await writeFile(join(show, 'concert-media.json'), JSON.stringify({
      version: 1, concert_id: 700, user_id: 'user-1', concert: {},
      files: [
        { name: 'a.mp4', kind: 'VIDEO', band_id: 9, band_name: 'Gojira', song: 'Stranded' },
        { name: 'b.jpg', kind: 'PHOTO', band_id: 3, band_name: 'Alcest', song: null },
      ],
    }));

    prisma.concert.findMany.mockResolvedValue([]);
    prisma.concertMedia.findMany.mockResolvedValue([{ rel_path: 'user-1/2026-06-12 Oslo - Gojira/a.mp4' }]);
    prisma.concertMedia.updateMany = vi.fn(async () => ({ count: 1 }));

    const res = await request(app).delete('/bands/9').set(...authHeader({ role: 'ADMIN' }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ untaggedFiles: 1, untagFailed: 0 });
    expect(prisma.concertMedia.updateMany).toHaveBeenCalledWith({
      where: { band_id: 9 },
      data: { band_id: null, song: null },
    });
    const { readFile } = await import('node:fs/promises');
    const sidecar = JSON.parse(await readFile(join(show, 'concert-media.json'), 'utf8'));
    expect(sidecar.files).toEqual([
      { name: 'a.mp4', kind: 'VIDEO', band_id: null, band_name: null, song: null },
      { name: 'b.jpg', kind: 'PHOTO', band_id: 3, band_name: 'Alcest', song: null },
    ]);
  });
});

describe('band id validation on the sync routes', () => {
  it('answers 400 for a band id that is not a number', async () => {
    const res = await request(app).post('/bands/abc/sync-concerts').set(...authHeader({ role: 'ADMIN' }));

    expect(res.status).toBe(400);
    expect(prisma.band.findUnique).not.toHaveBeenCalled();
  });

  it('skips a malformed entry in a reconcile rather than throwing on it', async () => {
    prisma.concert.findMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .post('/bands/5/reconcile')
      .set(...authHeader({ role: 'SYSTEM' }))
      .send({ upcoming: [null, 'x', { concert_date: '2030-01-01', venue: 'Debaser', city: 'Stockholm' }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stale_removed: 0, resync_bands: [] });
  });
});

describe('POST /bands/:bandId/reconcile', () => {
  // A concert the scraper no longer reports for this band. Support-act-only,
  // so unlinking the reconciled band leaves it with zero bands and orphans it.
  const staleDbConcert = {
    id: 800,
    event_id: null,
    concert_date: new Date('2030-06-01T20:00:00Z'),
    venue: 'Slakthuset',
    city: 'Stockholm',
    latitude: '59.3',
    longitude: '18.0',
    festival: false,
    bands: [{ band_rel: { id: 3, name: 'Support Act', songkick_url: null, bandsintown_url: null } }],
  };

  beforeEach(() => {
    prisma.concert.findMany
      .mockResolvedValueOnce([staleDbConcert]) // this band's future concerts, checked against `upcoming`
      .mockResolvedValueOnce([{ id: 800 }]); // the orphans query inside the transaction
    prisma.concertBandReference.deleteMany.mockResolvedValue({ count: 1 });
    prisma.concertAttendance.findMany.mockResolvedValue([{ id: 950 }]);
    prisma.concertMedia.findMany.mockResolvedValue([]);
    prisma.concertAttendance.deleteMany.mockResolvedValue({ count: 1 });
    prisma.concert.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('looks up media by the attendance ids behind an orphaned concert, not the concert id itself', async () => {
    const res = await request(app)
      .post('/bands/5/reconcile')
      .set(...authHeader({ role: 'ADMIN' }))
      // Decades away from staleDbConcert's date, so nothing matches and it is
      // flagged stale regardless of the day-window/venue/coordinate rules.
      .send({ upcoming: [{ concert_date: '2005-01-01', venue: 'Somewhere Else', city: 'Elsewhere' }] });

    expect(res.status).toBe(200);
    expect(prisma.concertAttendance.findMany).toHaveBeenCalledWith({
      where: { concert_id: { in: [800] } },
      select: { id: true },
    });
    // Names the attendance id (950), not the orphaned concert id (800).
    expect(prisma.concertMedia.findMany).toHaveBeenCalledWith({
      where: { attendance_id: { in: [950] } },
      select: { rel_path: true },
    });
  });
});

describe('a sync the Python service turns away', () => {
  // The failure this pins: the sync service began requiring SCRAPER_TOKEN, this
  // API was never given one, and every admin sync answered a 500 whose body was
  // axios's "Request failed with status code 401" — a status the admin's own
  // login had nothing to do with, naming nothing to go and fix.
  //
  // Served by a real socket rather than a stubbed client: the routers require
  // pythonService through CommonJS, so vi.mock cannot reach it for the same
  // reason installFakePrisma exists.
  let server;

  beforeAll(async () => {
    const { createServer } = await import('node:http');
    server = createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Unauthorized' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.PYTHON_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
    delete process.env.PYTHON_SERVICE_FALLBACK_URL;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  for (const path of ['/bands/sync-all', '/sync-weather', '/bands/sync-setlists']) {
    it(`answers ${path} with a bad gateway naming the shared secret`, async () => {
      const res = await request(app).post(path).set(...authHeader({ role: 'ADMIN' }));

      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/SCRAPER_TOKEN/);
      expect(res.body.error).not.toMatch(/Request failed with status/);
    });
  }

  it('reports a rejected single-band sync the same way', async () => {
    // Same laundering, on the route an admin reaches from one band's page
    // rather than from the sync panel.
    prisma.band.findUnique.mockResolvedValue({
      id: 1, name: 'Opeth', songkick_url: 'sk', bandsintown_url: null,
    });

    const res = await request(app).post('/bands/1/sync-concerts').set(...authHeader({ role: 'ADMIN' }));

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/SCRAPER_TOKEN/);
  });
});
