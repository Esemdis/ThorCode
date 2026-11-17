// What the process says when something escapes everything else (THO-1008). The
// two handlers used to log the raw reason, and a rejected axios call carries its
// request config: the outbound `Authorization` header, the sync service's
// SCRAPER_TOKEN or a Spotify or Tidal bearer, so the first call to the sync
// service that someone forgot a `.catch` on would have written a secret to the
// container log. THO-982 removed the two places that did it today; this is the
// last one, closed before anything uses it. `logFieldsFor` cuts an axios error
// down to its status, or its message when nothing answered, and leaves anything
// else whole, stack included, which is what these lines are for.

const { logFieldsFor } = require('./errorHandler');

function onUnhandledRejection(reason) {
  console.error('Unhandled promise rejection:', ...logFieldsFor(reason));
}

function onUncaughtException(err) {
  console.error('Uncaught exception:', ...logFieldsFor(err));
  process.exit(1);
}

module.exports = { onUnhandledRejection, onUncaughtException };
