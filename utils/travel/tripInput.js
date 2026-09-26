/**
 * Validate and normalise what a client sends when creating or editing a trip.
 *
 * The trip routes parsed their bodies inline, twice, and trusted the types:
 * a string in `tags`, a date that does not parse, an empty budget field or a
 * currency that is not text all reached Prisma and came back as a 500 with
 * nothing to say what was wrong. Same shape as placeInput.js — `{ data }` or
 * `{ error }` — so the routes answer 400 with a sentence instead.
 *
 * `partial` separates a PATCH from a POST: on a create, absent fields take
 * their defaults; on an update, absent fields stay absent so they are not
 * overwritten with them.
 */

const {
  INT32_MAX, DECIMAL_MAX, blank, text, date, number, currency, textList,
} = require('./fields');

const MINUTES_IN_DAY = 1440;
// A whole day of transfer is a typo, not a journey, and would eat the first
// and last day of the trip without saying why.
const MAX_TRANSFER_MIN = 720;

const BUDGET_FIELDS = ['money_budget', 'budget_flights', 'budget_hotel', 'budget_entertainment', 'budget_food'];

function normaliseTripInput(body = {}, { partial = false, withPlaces = false } = {}) {
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

  for (const field of BUDGET_FIELDS) {
    if (!given(field)) continue;
    const amount = number(body[field], { max: DECIMAL_MAX });
    if (amount === undefined) return { error: `${field} must be an amount from 0 to ${DECIMAL_MAX}` };
    data[field] = amount;
  }

  if (given('currency') || !partial) {
    if (blank(body.currency)) {
      if (!partial) data.currency = 'SEK';
      else return { error: 'currency must be a three-letter code' };
    } else {
      const code = currency(body.currency);
      if (!code) return { error: 'currency must be a three-letter code' };
      data.currency = code;
    }
  }

  if (given('tags') || !partial) {
    const tags = textList(body.tags);
    if (!tags) return { error: 'tags must be a list of text' };
    data.tags = tags;
  }

  if (given('exchange_rates')) {
    const rates = body.exchange_rates;
    if (rates !== null && (typeof rates !== 'object' || Array.isArray(rates))) {
      return { error: 'exchange_rates must be an object' };
    }
    data.exchange_rates = rates;
  }

  // Minutes since midnight, and a day is 1440 of them. Out of range means a
  // client sent something other than minutes, which would silently produce an
  // impossible day window rather than an error anybody could act on.
  for (const field of ['arrival_time', 'departure_time']) {
    if (!given(field)) continue;
    const minutes = number(body[field], { max: MINUTES_IN_DAY - 1, integer: true });
    if (minutes === undefined) return { error: `${field} must be minutes since midnight, 0 to 1439` };
    data[field] = minutes;
  }

  if (given('transfer_minutes')) {
    const minutes = number(body.transfer_minutes, { max: MAX_TRANSFER_MIN, integer: true });
    if (minutes === undefined) return { error: `transfer_minutes must be 0 to ${MAX_TRANSFER_MIN}` };
    data.transfer_minutes = minutes;
  }

  // Only on an existing trip: a new one has no places for these to name.
  if (withPlaces) {
    for (const field of ['arrival_place_id', 'departure_place_id']) {
      if (!given(field)) continue;
      const id = number(body[field], { min: 1, max: INT32_MAX, integer: true });
      if (id === undefined) return { error: `${field} must be a place id` };
      data[field] = id;
    }
  }

  return { data };
}

module.exports = { normaliseTripInput, DECIMAL_MAX, MAX_TRANSFER_MIN };
