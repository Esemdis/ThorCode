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
  buildPlaylistTracks, concertPerformers, unresolvedBillNames, mergeNight,
  playlistName, playlistDescription, coverCredits,
} = require('../../utils/setlistPlaylist');
// Both through the module rather than destructured, so a test can stand in
// for setlist.fm and Spotify on the router's own copies of them.
const externalSetlists = require('../../utils/externalSetlists');
const spotify = require('../../utils/spotify');

// Every track is a search, so this is the expensive route in the file.
const rateLimit = rateLimiter({
  message: 'Too many playlists, please try again in a minute.',
  max: 5,
});

// Searches run a few at a time. Higher gets rate limited on a festival bill and
// the waiting costs more than the concurrency saved.
const SEARCH_CONCURRENCY = 4;

// How many rows one night may be folded from. A festival day is a row per
// stage pairing the scraper saw, which runs to a few dozen on the biggest
// bills; the setlist.fm budget and the track cap bound the rest of the cost.
const MAX_NIGHT_ROWS = 50;

const CONCERT_SELECT = {
  id: true, name: true, venue: true, city: true, concert_date: true, metadata: true,
  bands: {
    select: {
      setlist: true,
      band_rel: { select: { id: true, name: true, setlist: true } },
    },
  },
};

/**
 * The night's other concert rows from the request body, or null when the body
 * names them wrongly. Absent is no others: a single show is one row.
 */
function otherRowsAsked(body, concertId) {
  const asked = body?.concert_ids;
  if (asked === undefined || asked === null) return [];
  if (!Array.isArray(asked) || asked.length > MAX_NIGHT_ROWS
    || !asked.every((id) => Number.isInteger(id) && id > 0)) return null;
  return [...new Set(asked)].filter((id) => id !== concertId);
}

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
      results[index] = await spotify.findTrack(token, tracks[index]);
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
 *
 * Body, optional: `concert_ids`, every concert row the night is stored as. A
 * festival day is a row per stage pairing, shown as one night, and its
 * playlist is the whole day's bill — named after the row in the URL.
 */
router.post('/:concertId/playlist', auth, rateLimit, async (req, res) => {
  const concertId = parseInt(req.params.concertId, 10);
  if (Number.isNaN(concertId)) return res.status(400).json({ error: 'Invalid concert id' });
  const otherIds = otherRowsAsked(req.body, concertId);
  if (!otherIds) return res.status(400).json({ error: 'concert_ids must be a list of concert ids' });

  try {
    const lead = await prisma.concert.findUnique({ where: { id: concertId }, select: CONCERT_SELECT });
    if (!lead) return res.status(404).json({ error: 'Concert not found' });
    // Rows that are gone are left out rather than failing the night: the rest
    // of the bill is still worth a playlist.
    const others = otherIds.length
      ? await prisma.concert.findMany({ where: { id: { in: otherIds } }, select: CONCERT_SELECT })
      : [];
    const concert = mergeNight(lead, others);

    // Before anything is fetched: with no Spotify to put the playlist in, the
    // setlist.fm searches below — one per act, on the key every user shares —
    // were spent for nothing.
    const token = await spotify.getValidToken(req.user.id);

    // A concert is the whole bill, not just the acts you follow. The names of
    // the rest are in metadata; their songs have to be fetched.
    const external = await externalSetlists.fetchSetlistsForNames(unresolvedBillNames(concert));
    const performers = concertPerformers(concert, external);

    const tracks = buildPlaylistTracks(performers);
    if (tracks.length === 0) {
      return res.status(422).json({
        error: 'No setlists for the bands on this concert yet, so there is nothing to add.',
      });
    }

    const { uris, missed } = await resolveTracks(token, tracks);

    if (uris.length === 0) {
      return res.status(422).json({
        error: 'None of the songs on this setlist could be found on Spotify.',
        missed,
      });
    }

    const playlist = await spotify.createPlaylist(token, {
      name: playlistName(concert),
      description: playlistDescription(concert, tracks),
    });
    await spotify.addItems(token, playlist.id, uris);

    res.status(201).json({
      url: playlist.url,
      name: playlistName(concert),
      added: uris.length,
      requested: tracks.length,
      missed,
      predicted: tracks.some((t) => t.predicted),
      bands: [...new Set(tracks.map((t) => t.band))],
      // Covers are searched for under the artist who wrote them, so the
      // playlist can hold a band that is not on the bill and `bands` will not
      // mention it. Sent for every cover, not only the resolved ones: an
      // unresolved one is already sitting in `missed` under the same
      // unexplained artist name.
      covers: coverCredits(tracks),
    });
  } catch (error) {
    // Not connected, or a refresh token the user has revoked. Either way the fix
    // is to connect again, which is a different thing to tell them than "it
    // broke" — 409 so the client can offer that instead of an error.
    if (error instanceof spotify.SpotifyAuthError) {
      return res.status(409).json({ error: error.message, reconnect: true });
    }
    console.error(`[playlist] Concert ${concertId}:`, error.response?.data ?? error.message);
    res.status(500).json({ error: 'Could not build the playlist' });
  }
});

module.exports = router;
