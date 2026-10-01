// Connecting a user's Spotify account, so their setlist playlists land in it.
// The routes are shared with Tidal — see routes/oauth/musicAccount.js.

// Through the module rather than destructured, so a test can stand in for
// Spotify on the router's own copy of it.
const spotify = require('../../utils/spotify');
const { musicAccountRouter } = require('./musicAccount');

// Spotify's token response does not say whose it is; the profile does.
module.exports = musicAccountRouter(spotify, async (token) => (await spotify.me(token.access_token)).id);
