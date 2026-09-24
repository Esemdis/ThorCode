/**
 * Which indexed files are not where the index says they are.
 *
 * Postgres is a copy of what the sidecars say, so a row whose file is absent is
 * not a database problem — it is a claim about the archive that the archive does
 * not support. There are two ways that happens and they want opposite responses,
 * which is the whole reason this groups rather than counts:
 *
 * - The show's folder is missing entirely. Those files were never in THIS
 *   archive. `dev` and `prd` share one database while pointing at different
 *   `MEDIA_ROOT`s, so a night uploaded from a workstation is a permanently
 *   broken tile in the deployed gallery, and no rebuild can repair it: the
 *   bytes are under the other root, or nowhere. They have to be copied across.
 *
 * - The folder is here and one file in it is not. That is drift inside an
 *   archive this deployment does own — a file moved or renamed outside the app —
 *   and `scripts/rebuild-media-index.js` is what reconciles it, because the
 *   sidecar beside it still says what should be there.
 *
 * Kept separate from the script so the grouping can be tested without a share
 * to point at.
 */

const path = require('node:path');

/** The show folder a file belongs to, as the archive lays it out. */
function showDir(relPath) {
  // posix regardless of host: rel_path is built with forward slashes and the
  // illegal-character filter strips backslashes, so a Windows-style separator
  // here would be data corruption rather than a platform difference.
  const dir = path.posix.dirname(String(relPath ?? ''));
  return dir === '.' ? '' : dir;
}

/**
 * Group the rows whose file is absent, by show, and say which kind of absence.
 *
 * @param {Array<{id: number, rel_path: string, bytes?: number|null,
 *   fileExists: boolean, folderExists: boolean}>} rows
 *   Presence is decided by the caller: one stat per file and one per folder is
 *   the script's job, and passing the answers in is what keeps this pure.
 * @returns {{present: number, missing: number, bytes: number,
 *   shows: Array<{dir: string, kind: 'folder_missing'|'file_missing',
 *   rows: object[], bytes: number}>}}
 *   `shows` is ordered folder-missing first, then by folder, so the group that
 *   needs bytes moved is the one at the top of the report.
 */
function groupMissing(rows) {
  const absent = (rows ?? []).filter((row) => !row.fileExists);
  const present = (rows ?? []).length - absent.length;

  const byDir = new Map();
  for (const row of absent) {
    const dir = showDir(row.rel_path);
    const group = byDir.get(dir);
    if (group) group.rows.push(row);
    else byDir.set(dir, { dir, kind: row.folderExists ? 'file_missing' : 'folder_missing', rows: [row] });
  }

  const shows = [...byDir.values()].map((group) => ({
    ...group,
    bytes: group.rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0),
  }));

  // Folder-missing first: it is the kind that cannot be fixed from inside this
  // deployment, so it is the kind worth reading before the terminal scrolls.
  shows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder_missing' ? -1 : 1;
    return a.dir.localeCompare(b.dir);
  });

  return {
    present,
    missing: absent.length,
    bytes: shows.reduce((sum, group) => sum + group.bytes, 0),
    shows,
  };
}

/**
 * One line naming a show, for the report.
 *
 * The date is sliced rather than parsed: `concert_date` is a calendar day, and
 * reading it through a local Date slides a midnight show into the previous day
 * for anyone west of UTC.
 */
function showLabel(row) {
  const concert = row.attendance_rel?.concert_rel;
  if (!concert) return 'unknown show';
  const day = String(concert.concert_date ?? '').slice(0, 10) || 'undated';
  const place = [concert.venue, concert.city].filter(Boolean).join(', ');
  return place ? `${day} — ${place}` : day;
}

module.exports = { showDir, groupMissing, showLabel };
