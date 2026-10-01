// Connecting a user's Tidal account, so their setlist playlists land in it.
// The routes are shared with Spotify — see routes/oauth/musicAccount.js.

const tidal = require('../../utils/tidal');
const { musicAccountRouter } = require('./musicAccount');

// The token response names the account, so there is no profile to fetch.
module.exports = musicAccountRouter(tidal, (token) => token.user_id);
