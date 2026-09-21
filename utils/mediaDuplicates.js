/**
 * Files the archive holds more than one copy of.
 *
 * Uploads were deduplicated by filename alone until the checksum check was
 * added, so the same photograph sent twice was stored again as
 * "IMG_1 (2).jpg": a second copy on disk, a second row, a second sidecar
 * entry and a second file synced to Drive. The checksum that proves it was
 * written every time and never read.
 *
 * Kept out of the script so the grouping rule can be tested without a
 * database, the same split as planRebuild and rebuild-media-index.js.
 */

/**
 * Group rows into sets that are byte-identical within one show.
 *
 * Grouped within a show, not across the archive: the same bytes under two
 * attendances are two people's copies of one photograph, or one person's
 * record of two nights, and neither is a duplicate to clean up.
 *
 * @param {object[]} rows - ConcertMedia rows with `id`, `attendance_id`, `sha256`.
 * @returns {object[][]} Groups of two or more, biggest first, oldest row first
 *   inside each group.
 */
function groupDuplicates(rows) {
  const byKey = new Map();
  for (const row of rows) {
    // A row with no checksum cannot be proven identical to anything. Skipped
    // rather than grouped under a shared null, which would report every
    // unhashed file in a show as copies of each other.
    if (!row.sha256) continue;
    const key = `${row.attendance_id}|${row.sha256}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  return [...byKey.values()]
    .filter((group) => group.length > 1)
    // Oldest first inside a group: the first listed is the one worth keeping,
    // being the row any existing tags and the sidecar entry are attached to.
    .map((group) => [...group].sort((a, b) => a.id - b.id))
    .sort((a, b) => b.length - a.length || a[0].id - b[0].id);
}

/** Bytes that would be freed by keeping one copy of each group. */
function redundantBytes(groups) {
  return groups.reduce(
    (sum, group) => sum + group.slice(1).reduce((n, r) => n + (r.bytes ?? 0), 0), 0,
  );
}

module.exports = { groupDuplicates, redundantBytes };
