/**
 * The body of a bulk reorder — `[{ id, sort_order }, …]` — checked before it
 * becomes a transaction of updates.
 *
 * Both reorder routes handed each entry straight to Prisma, so one entry with a
 * string or a missing field failed the whole transaction as a 500. Numeric
 * strings are accepted, since a form may send them; anything else is a 400
 * naming the problem.
 */

const INT32_MAX = 2147483647;
// Far more than any one trip's list, and a bound on one request's transaction.
const MAX_ENTRIES = 1000;

function parseReorder(list, label = 'items') {
  if (!Array.isArray(list)) return { error: `${label} must be an array` };
  if (list.length > MAX_ENTRIES) return { error: `Reorder at most ${MAX_ENTRIES} ${label} at once` };

  const entries = [];
  for (const entry of list) {
    const id = Number(entry?.id);
    const sortOrder = Number(entry?.sort_order);
    if (!Number.isInteger(id) || id < 1 || id > INT32_MAX
        || !Number.isInteger(sortOrder) || Math.abs(sortOrder) > INT32_MAX) {
      return { error: `Each of ${label} needs a whole-number id and sort_order` };
    }
    entries.push({ id, sort_order: sortOrder });
  }
  return { entries };
}

module.exports = { parseReorder, MAX_ENTRIES };
