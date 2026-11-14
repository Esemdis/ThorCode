/**
 * When a reconcile asks to remove too much of a band's schedule to be believed.
 *
 * A scrape that read one page of thirty shows is a short list, not a schedule
 * that shrank. Acting on it unlinks the band from the other twenty-nine and
 * deletes every show left with no bands and no attendance, which cascades to
 * the follows and to the record of which wishlists were told about it. The
 * next full sync recreates them under new ids and tells every follower again.
 */

// Under three future shows a share means nothing: 1 of 1 is a real
// cancellation, and 1 of 2 is exactly half, which proceeds anyway.
const RECONCILE_GUARD_MIN_FUTURE = 3;

// Strictly more than half is refused; exactly half proceeds. Compared as
// staleCount * 2 > futureTotal so it stays in integers.
function shouldRefuseReconcile(staleCount, futureTotal) {
  return futureTotal >= RECONCILE_GUARD_MIN_FUTURE && staleCount * 2 > futureTotal;
}

module.exports = { RECONCILE_GUARD_MIN_FUTURE, shouldRefuseReconcile };
