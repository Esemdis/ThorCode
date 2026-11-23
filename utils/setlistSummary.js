/**
 * What the attendance list says about a band's setlist instead of sending it.
 *
 * The whole history used to carry every song of every set, and the app reads
 * that list on every load to draw cards whose setlists start closed (THO-967).
 * The count is enough to draw the toggle ("12 songs"), and the link is enough
 * for the CSV export; the songs themselves are fetched when a card is opened.
 *
 * Tape is left out of the count for the same reason every setlist view leaves
 * it out: walk-on and outro music over the PA is not something the band played
 * (see setlistPlaylist.js), and the client counts performed entries the same way.
 *
 * @param {object|null|undefined} setlist - ConcertBandReference.setlist: `{ songs, url }`.
 * @returns {{ setlist_songs: number, setlist_url: string|null }}
 */
function setlistSummary(setlist) {
  const songs = Array.isArray(setlist?.songs) ? setlist.songs : [];
  const url = typeof setlist?.url === "string" && setlist.url ? setlist.url : null;
  return {
    setlist_songs: songs.filter((song) => song && !song.tape).length,
    setlist_url: url,
  };
}

module.exports = { setlistSummary };
