// Totals the results of a chunk of prisma `updateMany` calls. `updateMany`
// reports { count } — 0 when the row has been deleted since the caller read it
// — so the number written is the sum of counts, not the number of ids sent.
// Counting ids would report a deleted trip as updated.
function sumCounts(results) {
  return results.reduce((total, r) => total + (r && Number.isInteger(r.count) ? r.count : 0), 0);
}

module.exports = { sumCounts };
