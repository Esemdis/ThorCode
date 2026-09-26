import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { installFakePrisma } from '../test/routeApp.js';

const prisma = installFakePrisma({ band: { findUnique: vi.fn(), create: vi.fn() } });

// This file's own copies — it is CommonJS and loads them through Node's
// require, which an ESM import would not share.
const require = createRequire(import.meta.url);
const bandSourceUrls = require('./bandSourceUrls.js');
const bandBacklink = require('./bandBacklink.js');
const pythonService = require('./pythonService.js');
const { createBand, BandExistsError } = require('./bandCreate.js');

const MBID = '5a7e05a6-a9f5-4f5a-9d0c-6c0d7c7d4c1a';
const uniqueViolation = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

describe('createBand', () => {
  beforeEach(() => {
    vi.spyOn(bandSourceUrls, 'findSourceUrls').mockResolvedValue(['https://sk.example/a', null, MBID]);
    vi.spyOn(bandBacklink, 'backlinkBandToConcerts').mockResolvedValue(undefined);
    vi.spyOn(pythonService, 'pythonServicePost').mockResolvedValue({});
  });

  it('creates the band with what the lookup found and starts its sync', async () => {
    prisma.band.findUnique.mockResolvedValue(null);
    prisma.band.create.mockImplementation(async ({ data }) => ({ id: 9, ...data }));

    const out = await createBand('Gojira');

    expect(out.band).toMatchObject({ id: 9, name: 'Gojira', MBID, songkick_url: 'https://sk.example/a' });
    expect(out.warning).toBeNull();
    expect(bandBacklink.backlinkBandToConcerts).toHaveBeenCalledWith(expect.objectContaining({ bandId: 9 }));
    expect(pythonService.pythonServicePost).toHaveBeenCalledWith('/sync/9', expect.any(Object));
  });

  it('refuses a name already stored, before asking MusicBrainz', async () => {
    prisma.band.findUnique.mockResolvedValue({ id: 3, name: 'Gojira' });

    await expect(createBand('Gojira')).rejects.toBeInstanceOf(BandExistsError);
    expect(bandSourceUrls.findSourceUrls).not.toHaveBeenCalled();
  });

  it('answers with the stored band when MusicBrainz says it is the same artist', async () => {
    // "Architects (UK)" resolving to the MBID "Architects" already holds. MBID
    // is unique, so the create failed, the re-read by name found nothing, and
    // the request was a 500.
    const stored = { id: 4, name: 'Architects', MBID };
    prisma.band.findUnique.mockImplementation(async ({ where }) => (where.MBID === MBID ? stored : null));
    prisma.band.create.mockRejectedValue(uniqueViolation());

    const err = await createBand('Architects (UK)').catch((e) => e);

    expect(err).toBeInstanceOf(BandExistsError);
    expect(err.band).toBe(stored);
    expect(pythonService.pythonServicePost).not.toHaveBeenCalled();
  });

  it('still fails on a unique violation it cannot explain', async () => {
    prisma.band.findUnique.mockResolvedValue(null);
    prisma.band.create.mockRejectedValue(uniqueViolation());

    await expect(createBand('Gojira')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('creates the band anyway when MusicBrainz is down, and says so', async () => {
    bandSourceUrls.findSourceUrls.mockRejectedValue(new Error('ETIMEDOUT'));
    prisma.band.findUnique.mockResolvedValue(null);
    prisma.band.create.mockImplementation(async ({ data }) => ({ id: 9, ...data }));

    const out = await createBand('Gojira');

    expect(out.band.MBID).toBeNull();
    expect(out.band.source_urls_checked_at).toBeUndefined();
    expect(out.warning).toMatch(/MusicBrainz/);
  });
});
