import { describe, it, expect } from 'vitest';
import { unlinkedConcertsNamingBand, backlinkBandToConcerts } from './bandBacklink.js';

describe('unlinkedConcertsNamingBand', () => {
  it('finds the gig whose bill names the band but never linked it', () => {
    // The Glasgow duplicate: Dance Gavin Dance at Galvanizers SWG3 was ingested
    // in May with "As December Falls" already on its bill, months before the
    // band existed as a row to link to. Nothing linked it afterwards, so the
    // September Bandsintown scrape had no shared band to dedup against and
    // filed As December Falls as a second concert 139 m up the road.
    const concerts = [
      { id: 12818, metadata: '["Dance Gavin Dance", "As December Falls"]', bands: [{ band: 75 }] },
      { id: 12884, metadata: '["Spiritbox", "JINJER"]', bands: [{ band: 82 }] },
    ];

    expect(unlinkedConcertsNamingBand({ bandId: 226, bandName: 'As December Falls', concerts }))
      .toEqual([12818]);
  });

  it('skips a concert the band is already linked to', () => {
    const concerts = [
      { id: 13899, metadata: '["As December Falls"]', bands: [{ band: 226 }] },
    ];

    expect(unlinkedConcertsNamingBand({ bandId: 226, bandName: 'As December Falls', concerts }))
      .toEqual([]);
  });

  it('matches through the scraper noise that stops a raw name comparison', () => {
    const concerts = [
      { id: 1, metadata: '["Counterparts266K Followers"]', bands: [] },
      { id: 2, metadata: '["Architects (UK)"]', bands: [] },
    ];

    expect(unlinkedConcertsNamingBand({ bandId: 9, bandName: 'Counterparts', concerts })).toEqual([1]);
    expect(unlinkedConcertsNamingBand({ bandId: 9, bandName: 'Architects', concerts })).toEqual([2]);
  });

  it('does not link a band to a different band with a similar name', () => {
    // The reason this matches canonically rather than by similarity score:
    // "Nothing" scores 0.75 against "Nothing More" and "Alestorm" 0.93 against
    // "Halestorm". A missed link shows as a grey name you can add by hand; a
    // wrong one puts a show on the map that the band is not playing.
    const concerts = [
      { id: 1, metadata: '["Nothing More"]', bands: [] },
      { id: 2, metadata: '["Halestorm"]', bands: [] },
    ];

    expect(unlinkedConcertsNamingBand({ bandId: 9, bandName: 'Nothing', concerts })).toEqual([]);
    expect(unlinkedConcertsNamingBand({ bandId: 9, bandName: 'Alestorm', concerts })).toEqual([]);
  });

  it('ignores rows whose metadata is missing or is not a lineup', () => {
    // metadata is a free-form text column and older rows hold other things.
    const concerts = [
      { id: 1, metadata: null, bands: [] },
      { id: 2, metadata: 'not json', bands: [] },
      { id: 3, metadata: '{"headliner":"Opeth"}', bands: [] },
      { id: 4, metadata: '["Opeth"]', bands: [] },
    ];

    expect(unlinkedConcertsNamingBand({ bandId: 9, bandName: 'Opeth', concerts })).toEqual([4]);
  });

  it('returns nothing when the band name is empty or unusable', () => {
    const concerts = [{ id: 1, metadata: '["Opeth"]', bands: [] }];

    expect(unlinkedConcertsNamingBand({ bandId: 9, bandName: '', concerts })).toEqual([]);
    expect(unlinkedConcertsNamingBand({ bandId: 9, bandName: null, concerts })).toEqual([]);
  });
});

describe('backlinkBandToConcerts', () => {
  // A stand-in for the Prisma client: findMany serves rows the way the DB would,
  // honouring the date filter the query asks for, and the writes are recorded.
  const clientWith = (rows) => {
    const created = [];
    return {
      created,
      concert: {
        findMany: async (args) => {
          const from = args?.where?.concert_date?.gte;
          return rows.filter((r) => !from || (r.concert_date && r.concert_date >= from));
        },
      },
      concertBandReference: {
        createMany: async ({ data }) => { created.push(...data); return { count: data.length }; },
      },
    };
  };

  const soon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  it('links the band to the upcoming bills that already name it', async () => {
    const client = clientWith([
      { id: 12818, concert_date: soon, metadata: '["Dance Gavin Dance", "As December Falls"]', bands: [{ band: 75 }] },
      { id: 12884, concert_date: soon, metadata: '["Spiritbox"]', bands: [{ band: 82 }] },
    ]);

    const linked = await backlinkBandToConcerts({ bandId: 226, bandName: 'As December Falls', prisma: client });

    expect(linked).toEqual([12818]);
    expect(client.created).toEqual([{ concert: 12818, band: 226 }]);
  });

  it('leaves concerts that have already happened alone', async () => {
    // Back-linking is about gigs still to come: it exists to stop a duplicate
    // being filed for one, and rewriting who played a past show is a different
    // decision with nothing asking for it.
    const client = clientWith([
      { id: 5, concert_date: longAgo, metadata: '["As December Falls"]', bands: [] },
    ]);

    const linked = await backlinkBandToConcerts({ bandId: 226, bandName: 'As December Falls', prisma: client });

    expect(linked).toEqual([]);
    expect(client.created).toEqual([]);
  });

  it('survives a link that /bulk created between the read and the write', async () => {
    // ConcertBandReference is unique on (concert, band), so a scrape linking the
    // same pair in the gap would reject the whole batch and lose every other
    // link in it. Prisma's skipDuplicates is what makes the write idempotent.
    const client = {
      created: [],
      concert: {
        findMany: async () => [
          { id: 1, concert_date: soon, metadata: '["Wind Walkers"]', bands: [] },
          { id: 2, concert_date: soon, metadata: '["Wind Walkers"]', bands: [] },
        ],
      },
      concertBandReference: {
        createMany: async ({ data, skipDuplicates }) => {
          // Concert 1 was linked by something else a moment ago.
          if (!skipDuplicates && data.some((d) => d.concert === 1)) {
            throw new Error('Unique constraint failed on the fields: (`concert`,`band`)');
          }
          client.created.push(...data);
          return { count: data.length };
        },
      },
    };

    const linked = await backlinkBandToConcerts({ bandId: 225, bandName: 'Wind Walkers', prisma: client });

    expect(linked).toEqual([1, 2]);
    expect(client.created).toEqual([{ concert: 1, band: 225 }, { concert: 2, band: 225 }]);
  });

  it('writes nothing when no bill names the band', async () => {
    const client = clientWith([
      { id: 12884, concert_date: soon, metadata: '["Spiritbox"]', bands: [{ band: 82 }] },
    ]);

    expect(await backlinkBandToConcerts({ bandId: 226, bandName: 'As December Falls', prisma: client })).toEqual([]);
    expect(client.created).toEqual([]);
  });
});
