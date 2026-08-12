// Building a Spotify playlist from a concert's setlists.
//
// A third router on /data/concerts alongside ticketmaster and notifications,
// rather than more lines in bands.js, which is already 1,600 of them.

const express = require('express');
const router = express.Router();
const prisma = require('../../prisma/client');

const auth = require('../../auth/verifyJWT');
const { rateLimiter } = require('../../utils/rateLimiter');
const {
  buildPlaylistTracks, concertPerformers, unresolvedBillNames,
  playlistName, playlistDescription,
} = require('../../utils/setlistPlaylist');
const { fetchSetlistsForNames } = require('../../utils/externalSetlists');
const {
  SpotifyAuthError, getValidToken, findTrack, createPlaylist, addItems,
} = require('../../utils/spotify');

// Every track is a search, so this is the expensive route in the file.
const rateLimit = rateLimiter({
  message: 'Too many playlists, please try again in a minute.',
  max: 5,
});

// Searches run a few at a time. Higher gets rate limited on a festival bill and
// the waiting costs more than the concurrency saved.
const SEARCH_CONCURRENCY = 4;

/**
 * Resolve every track to a Spotify URI, a few at a time, preserving set order.
 * Returns the URIs found and the songs that came back with nothing.
 */
async function resolveTracks(token, tracks) {
  const results = new Array(tracks.length).fill(null);
  let cursor = 0;

  const worker = async () => {
    while (cursor < tracks.length) {
      const index = cursor++;
      results[index] = await findTrack(token, tracks[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(SEARCH_CONCURRENCY, tracks.length) }, worker),
  );

  const uris = [];
  const missed = [];
  results.forEach((found, i) => {
    if (found) uris.push(found.uri);
    else missed.push(`${tracks[i].artist} — ${tracks[i].title}`);
  });
  return { uris, missed };
}

/**
 * POST /data/concerts/:concertId/playlist
 *
 * Creates a private Spotify playlist from the setlists of the bands on this
 * concert and returns its URL, along with the songs that could not be found —
 * live-only material and re-recordings will not all resolve, and a short
 * playlist with no explanation reads as a bug.
 */
router.post('/:concertId/playlist', auth, rateLimit, async (req, res) => {
  const concertId = parseInt(req.params.concertId, 10);
  if (Number.isNaN(concertId)) return res.status(400).json({ error: 'Invalid concert id' });

  try {
    const concert = await prisma.concert.findUnique({
      where: { id: concertId },
      select: {
        id: true, name: true, venue: true, city: true, concert_date: true, metadata: true,
        bands: {
          select: {
            setlist: true,
            band_rel: { select: { id: true, name: true, setlist: true } },
          },
        },
      },
    });
    if (!concert) return res.status(404).json({ error: 'Concert not found' });

    // A concert is the whole bill, not just the acts you follow. The names of
    // the rest are in metadata; their songs have to be fetched.
    const external = await fetchSetlistsForNames(unresolvedBillNames(concert));
    const performers = concertPerformers(concert, external);

    const tracks = buildPlaylistTracks(performers);
    if (tracks.length === 0) {
      return res.status(422).json({
        error: 'No setlists for the bands on this concert yet, so there is nothing to add.',
      });
    }

    const token = await getValidToken(req.user.id);
    const { uris, missed } = await resolveTracks(token, tracks);

    if (uris.length === 0) {
      return res.status(422).json({
        error: 'None of the songs on this setlist could be found on Spotify.',
        missed,
      });
    }

    const playlist = await createPlaylist(token, {
      name: playlistName(concert),
      description: playlistDescription(concert, tracks),
    });
    await addItems(token, playlist.id, uris);

    res.status(201).json({
      url: playlist.url,
      name: playlistName(concert),
      added: uris.length,
      requested: tracks.length,
      missed,
      predicted: tracks.some((t) => t.predicted),
      bands: [...new Set(tracks.map((t) => t.band))],
    });
  } catch (error) {
    // Not connected, or a refresh token the user has revoked. Either way the fix
    // is to connect again, which is a different thing to tell them than "it
    // broke" — 409 so the client can offer that instead of an error.
    if (error instanceof SpotifyAuthError) {
      return res.status(409).json({ error: error.message, reconnect: true });
    }
    console.error(`[playlist] Concert ${concertId}:`, error.response?.data ?? error.message);
    res.status(500).json({ error: 'Could not build the playlist' });
  }
});

module.exports = router;
