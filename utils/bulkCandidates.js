/**
 * The stored rows /bulk checks its new shows against, read once per batch
 * (THO-968).
 *
 * checkDuplicateConcert used to read every concert within WINDOW_DAYS either
 * side of each incoming show, from every city, with its bill and band names.
 * A band's first sync brings hundreds of new shows, so hundreds of those
 * reads, all inside /bulk's one 60 s transaction.
 *
 * This reads them once, for the union of every show's window, and then has to
 * answer each show exactly as its own read would have. Two things make that
 * more than a cache:
 *
 * - The batch writes as it goes. A show inserted, merged into, flagged a
 *   festival or given another act earlier in the batch was visible to the next
 *   show's read, so every such write is mirrored here.
 * - A show can fail and be rolled back to its savepoint. Its writes are made
 *   to a staging buffer and applied only once the savepoint is released, so a
 *   rolled-back show leaves nothing behind for the next one to match.
 *
 * Rows are replaced on write, never changed in place, so a row a caller still
 * holds (ingest.js reports the matched row's name and bill) keeps reading as it
 * did when the show was checked.
 */
const { CANDIDATE_FIELDS, WINDOW_DAYS, DAY_MS, dayOf } = require('./concertDedup');

const SCALAR_FIELDS = Object.keys(CANDIDATE_FIELDS).filter((key) => key !== 'bands');

/** [day - WINDOW_DAYS, day + WINDOW_DAYS] in ms, the bounds checkDuplicateConcert reads. Null for no usable date. */
function windowOf(value) {
  const day = dayOf(value);
  if (Number.isNaN(day)) return null;
  return [day - WINDOW_DAYS * DAY_MS, day + WINDOW_DAYS * DAY_MS];
}

/**
 * Overlapping windows as one, sorted.
 *
 * Merged rather than replaced by one earliest-to-latest range: a tour spread
 * over a year would otherwise load every concert stored for that year to check
 * a few dozen nights. Still one read, as an OR of these.
 */
function mergeWindows(windows) {
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

function timeOf(row) {
  if (!row.concert_date) return NaN;
  return new Date(row.concert_date).getTime();
}

/** A row cut down to what CANDIDATE_FIELDS selects, so an insert's row reads like a loaded one. */
function candidateRow(row, bands) {
  const out = {};
  for (const key of SCALAR_FIELDS) out[key] = row[key] ?? null;
  out.bands = bands ?? row.bands ?? [];
  return out;
}

/**
 * Loads the candidates for every show in a batch that will reach the
 * duplicate check, in one read.
 *
 * @param {object} tx - the transaction client
 * @param {object[]} concerts - the shows that will be checked; undated ones
 *   are skipped, as checkDuplicateConcert skips them
 * @param {object} [options]
 * @param {(id: number) => string|null} [options.bandName] - a band's name, for
 *   the rows' `bands[].band_rel.name` when a write adds an act to a bill
 * @returns {Promise<object>} the store
 */
async function loadBulkCandidates(tx, concerts, { bandName = () => null } = {}) {
  const windows = mergeWindows(concerts.map((c) => windowOf(c.concert_date)).filter(Boolean));
  const rows = new Map();

  // Zero reads for a batch with no dated show, which is what the old per-show
  // read cost it too.
  if (windows.length > 0) {
    const loaded = await tx.concert.findMany({
      where: {
        OR: windows.map(([lo, hi]) => ({ concert_date: { gte: new Date(lo), lte: new Date(hi) } })),
      },
      select: CANDIDATE_FIELDS,
    });
    for (const row of loaded) rows.set(row.id, candidateRow(row));
  }

  const refOf = (band) => ({ band, band_rel: { name: bandName(band) ?? null } });

  const store = {
    /**
     * The rows one show's own read would have returned: those whose date now
     * is in [day - WINDOW_DAYS, day + WINDOW_DAYS], both ends included. Read
     * off each row's current date, so a row moved by an earlier show in the
     * batch is found where it went. Never pass the whole store to the check:
     * detectFestivalCluster has no date filter and would count rows a year off.
     */
    forShow(concert) {
      const bounds = windowOf(concert.concert_date);
      if (!bounds) return [];
      const [lo, hi] = bounds;
      return [...rows.values()].filter((row) => {
        const t = timeOf(row);
        return t >= lo && t <= hi;
      });
    },

    /** Whether a date falls in what was loaded, so a row moved there must be added. */
    covers(value) {
      const t = value ? new Date(value).getTime() : NaN;
      return windows.some(([lo, hi]) => t >= lo && t <= hi);
    },

    has(id) {
      return rows.has(id);
    },

    /** A buffer for one show's writes, applied by commit() and simply dropped on rollback. */
    stage() {
      const ops = [];
      return {
        ops,
        /** Fields written to a row; only those a candidate carries are kept. */
        merge(id, data) { ops.push({ kind: 'merge', id, data }); },
        /** Rows the cluster check flagged as a festival. */
        markFestival(ids) { ops.push({ kind: 'festival', ids: [...ids] }); },
        /** Acts put on a row's bill. */
        link(id, bandIds) { ops.push({ kind: 'link', id, bandIds: [...bandIds] }); },
        /** A row now in the loaded windows: one just inserted, or one moved into them. */
        add(row, bandIds) { ops.push({ kind: 'add', row, bandIds }); },
      };
    },

    /** Applies a show's staged writes. Called only after its savepoint is released. */
    commit(buffer) {
      for (const op of buffer.ops) {
        if (op.kind === 'add') {
          const bands = op.bandIds ? [...new Set(op.bandIds)].map(refOf) : undefined;
          rows.set(op.row.id, candidateRow(op.row, bands));
        } else if (op.kind === 'merge') {
          const row = rows.get(op.id);
          if (!row) continue;
          const picked = Object.fromEntries(
            Object.entries(op.data ?? {}).filter(([key, value]) => SCALAR_FIELDS.includes(key) && value !== undefined),
          );
          rows.set(op.id, { ...row, ...picked });
        } else if (op.kind === 'festival') {
          for (const id of op.ids) {
            const row = rows.get(id);
            if (row && !row.festival) rows.set(id, { ...row, festival: true });
          }
        } else if (op.kind === 'link') {
          const row = rows.get(op.id);
          if (!row) continue;
          const have = new Set(row.bands.map((ref) => ref.band));
          const added = [...new Set(op.bandIds)].filter((band) => !have.has(band));
          if (added.length > 0) rows.set(op.id, { ...row, bands: [...row.bands, ...added.map(refOf)] });
        }
      }
    },
  };
  return store;
}

module.exports = { loadBulkCandidates, mergeWindows };
