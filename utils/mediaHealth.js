/**
 * Whether the archive is actually there.
 *
 * `MEDIA_ROOT` being set proves nothing: the share is mounted over SMB, and a
 * mount that dropped — or one that had not come back yet after a restart —
 * leaves a perfectly ordinary empty directory at the mount point. Every path
 * resolves, every permission check passes, and every single byte route answers
 * 404 because the file genuinely is not there.
 *
 * That failure has no symptom of its own. The listing endpoints never touch
 * disk, so they keep working; the gallery fills with tiles whose images do not
 * load; and the app's own account of it is that there is nothing to show. It
 * cost an afternoon of hunting for a video codec once already.
 *
 * So it gets asked directly, in one place, by both `/health` and the startup
 * log. Cheap: one readdir of one directory, no recursion.
 */

const fs = require('node:fs/promises');
const { archiveRoot } = require('./mediaPaths');

/**
 * @returns {Promise<{root: string|null, readable: boolean, entries: number|null,
 *   reason: string|null}>}
 *   `entries` counts only the top level, which is one directory per owner —
 *   small, and zero is the number that matters. `reason` is a short code:
 *   `unconfigured`, `missing`, `not_a_directory`, `permission`, `empty`, or an
 *   errno for anything else.
 */
async function archiveStatus() {
  let root;
  try {
    root = archiveRoot();
  } catch {
    // mediaRoot() throws when MEDIA_ROOT is unset, and it throws on use rather
    // than at boot — which is exactly why this check exists.
    return { root: null, readable: false, entries: null, reason: 'unconfigured' };
  }

  try {
    const entries = await fs.readdir(root);
    // Readable and present, but with nothing in it. Technically fine on a brand
    // new install and alarming on any other, so it is reported rather than
    // judged: the caller knows whether this deployment has uploads.
    return {
      root,
      readable: true,
      entries: entries.length,
      reason: entries.length === 0 ? 'empty' : null,
    };
  } catch (err) {
    const reason = err.code === 'ENOENT' ? 'missing'
      : err.code === 'ENOTDIR' ? 'not_a_directory'
        : err.code === 'EACCES' || err.code === 'EPERM' ? 'permission'
          : err.code || 'unknown';
    return { root, readable: false, entries: null, reason };
  }
}

/**
 * One line for the startup log, or null when there is nothing to say.
 *
 * Deliberately not fatal. This process also serves the travel app, and a share
 * that is slow to mount after a host reboot is a normal morning — exiting would
 * turn a degraded gallery into an outage of everything. A warning that names
 * the path is enough to look in the right place.
 */
function archiveWarning({ root, readable, reason }) {
  if (readable && !reason) return null;
  if (reason === 'unconfigured') {
    return '[media] MEDIA_ROOT is not set: every photograph and video will 404.';
  }
  if (reason === 'empty') {
    return `[media] archive at ${root} is empty: if this deployment has uploads,`
      + ' the share is probably not mounted.';
  }
  return `[media] archive at ${root} is unreadable (${reason}): every photograph`
    + ' and video will 404 until it is back.';
}

module.exports = { archiveStatus, archiveWarning };
