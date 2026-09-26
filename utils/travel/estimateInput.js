/**
 * Validate and normalise what a client sends when adding or editing an
 * expense estimate on a trip.
 *
 * A create checked its category and amount and nothing else; an edit checked
 * nothing. A date that does not parse, a currency longer than the column's
 * three letters, an amount that is not a number or a category that is not
 * text all failed in Prisma or Postgres as a 500. Same `{ data }` or
 * `{ error }` shape as tripInput.js, so the route answers 400 with a sentence.
 *
 * `partial` separates a PATCH from a POST: on a create, absent fields take
 * their defaults; on an update, absent fields stay absent.
 */
const {
  INT32_MAX, INT32_MIN, DECIMAL_MAX, text, date, number, currency,
} = require('./fields');

function normaliseEstimateInput(body = {}, { partial = false } = {}) {
  const data = {};
  const given = (field) => body[field] !== undefined;

  if (given('category') || !partial) {
    const category = text(body.category, 100);
    if (!category) return { error: 'An estimate needs a category of at most 100 characters' };
    data.category = category;
  }

  // Negative stays allowed: the create route took anything isDecimal did, and
  // that includes a sign.
  if (given('amount') || !partial) {
    const amount = number(body.amount, { min: -DECIMAL_MAX, max: DECIMAL_MAX });
    if (amount == null) return { error: `amount must be a number of at most ${DECIMAL_MAX}` };
    data.amount = amount;
  }

  if (given('currency') || !partial) {
    const code = currency(body.currency);
    if (code === undefined) return { error: 'currency must be a three-letter code' };
    data.currency = code ?? 'SEK';
  }

  for (const field of ['date', 'end_date']) {
    if (!given(field) && partial) continue;
    const parsed = date(body[field]);
    if (parsed === undefined) return { error: `${field} must be a date` };
    data[field] = parsed;
  }

  if (given('note') || !partial) {
    const note = text(body.note);
    if (note === undefined) return { error: 'note must be text' };
    data.note = note;
  }

  if (given('sort_order') || !partial) {
    const position = number(body.sort_order, { min: INT32_MIN, max: INT32_MAX, integer: true });
    if (position === undefined) return { error: 'sort_order must be a whole number' };
    data.sort_order = position ?? 0;
  }

  return { data };
}

module.exports = { normaliseEstimateInput };
