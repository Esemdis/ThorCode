/**
 * Validate and normalise what a client sends when creating or editing a trip.
 *
 * The trip routes parsed their bodies inline, twice, and trusted the types:
 * a string in `tags`, a date that does not parse or an empty budget field all
 * reached Prisma and came back as a 500 with nothing to say what was wrong.
 * Same shape as gearInput.js — `{ data }` or `{ error }` — so the routes
 * answer 400 with a sentence instead.
 *
 * `partial` separates a PATCH from a POST: on a create, absent fields take
 * their defaults; on an update, absent fields stay absent so they are not
 * overwritten with them.
 */

const { INT32_MAX, text, date, number, textList } = require('./fields');

function normaliseTripInput(body = {}, { partial = false } = {}) {
  const data = {};
  const given = (field) => body[field] !== undefined;

  if (given('name') || !partial) {
    const name = text(body.name, 200);
    if (!name) return { error: 'A trip needs a name of at most 200 characters' };
    data.name = name;
  }

  if (given('destination')) {
    const destination = text(body.destination, 200);
    if (destination === undefined) return { error: 'destination must be text of at most 200 characters' };
    data.destination = destination;
  }

  if (given('notes')) {
    const notes = text(body.notes);
    if (notes === undefined) return { error: 'notes must be text' };
    data.notes = notes;
  }

  for (const field of ['start_date', 'end_date']) {
    if (!given(field)) continue;
    const parsed = date(body[field]);
    if (parsed === undefined) return { error: `${field} must be a date` };
    data[field] = parsed;
  }
  if (data.start_date && data.end_date && data.end_date < data.start_date) {
    return { error: 'The trip ends before it starts' };
  }

  if (given('weight_budget')) {
    const grams = number(body.weight_budget, { max: INT32_MAX, integer: true });
    if (grams === undefined) return { error: 'weight_budget must be a whole number of grams' };
    data.weight_budget = grams;
  }

  if (given('tags') || !partial) {
    const tags = textList(body.tags);
    if (!tags) return { error: 'tags must be a list of text' };
    data.tags = tags;
  }

  return { data };
}

module.exports = { normaliseTripInput };
