/**
 * `docker stop` sends SIGTERM and SIGKILLs whatever is still running when the
 * grace period ends. Node has no SIGTERM handler of its own, so until this the
 * signal was ignored and every deploy reset the requests still in flight.
 * Closing the server stops new connections and lets the open ones finish;
 * the process exits once they have, or is killed at the deadline as before.
 *
 * The Dockerfile has to `exec node` for this to fire at all: `sh -c "a && b"`
 * does not pass the signal on to its child.
 */
function closeOnSigterm(server, proc = process) {
  proc.once('SIGTERM', () => {
    console.log('SIGTERM received, closing the server');
    server.close(() => proc.exit(0));
  });
}

module.exports = { closeOnSigterm };
