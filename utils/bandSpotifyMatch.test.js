import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { installFakePrisma } from '../test/routeApp.js';

const prisma = installFakePrisma({ band: { update: vi.fn() } });

// This file's own copies — it is CommonJS and loads them through Node's
// require, which an ESM import would not share.
const require = createRequire(import.meta.url);
const spotify = require('./spotify.js');
const { matchBandToSpotify } = require('./bandSpotifyMatch.js');

describe('matchBandToSpotify when the artist is already another band\'s', () => {
  it('still records that the band was searched', async () => {
    // spotify_id is unique. Two bands resolving to one artist failed the whole
    // update, left spotify_checked_at empty, and the band was searched again on
    // every page view and every nightly run from then on.
    vi.spyOn(spotify, 'searchArtists').mockResolvedValue([{ id: 'sp-1', name: 'Gojira' }]);
    prisma.band.update
      .mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }))
      .mockResolvedValueOnce({});

    const id = await matchBandToSpotify({ id: 5, name: 'Gojira', spotify_id: null, spotify_checked_at: null });

    expect(id).toBe('sp-1');
    expect(prisma.band.update).toHaveBeenCalledTimes(2);
    expect(prisma.band.update).toHaveBeenLastCalledWith({
      where: { id: 5 },
      data: { spotify_checked_at: expect.any(Date) },
    });
  });

  it('does not stamp a band when Spotify itself failed', async () => {
    vi.spyOn(spotify, 'searchArtists').mockRejectedValue(new Error('503'));

    await matchBandToSpotify({ id: 5, name: 'Gojira', spotify_id: null, spotify_checked_at: null });

    expect(prisma.band.update).not.toHaveBeenCalled();
  });
});
