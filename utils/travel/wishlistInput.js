/**
 * Validate and normalise what a client sends when creating or editing a
 * wishlist item. The API returns `{ data }` or `{ error }`, so malformed
 * values become a 400 instead of a Prisma error or a `.trim()` TypeError.
 */
const {
  DECIMAL_MAX, NOTE_MAX_LENGTH, TAG_LIMITS, DIMENSIONS_MAX_JSON,
  text, number, currency, textList, tagsError, jsonObject,
} = require('./fields');

const TEXT_FIELDS = [
  ['brand', 100],
  ['model', 200],
  ['category', 100],
  ['url', 500],
];

function normaliseWishlistInput(body = {}, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'The wishlist item must be an object' };
  }

  const data = {};
  const given = (field) => body[field] !== undefined;

  if (given('name') || !partial) {
    const name = text(body.name, 200);
    if (!name) return { error: 'A wishlist item needs a name of at most 200 characters' };
    data.name = name;
  }

  for (const [field, max] of TEXT_FIELDS) {
    if (!given(field) && partial) continue;
    const value = text(body[field], max);
    if (value === undefined) return { error: `${field} must be text of at most ${max} characters` };
    data[field] = value;
  }

  if (given('notes') || !partial) {
    const notes = text(body.notes, NOTE_MAX_LENGTH);
    if (notes === undefined) return { error: `notes must be text of at most ${NOTE_MAX_LENGTH} characters` };
    data.notes = notes;
  }

  if (given('price') || !partial) {
    const price = number(body.price, { max: DECIMAL_MAX });
    if (price === undefined) return { error: `price must be an amount from 0 to ${DECIMAL_MAX}` };
    data.price = price;
  }

  if (given('currency') || !partial) {
    const code = currency(body.currency);
    if (code === undefined) return { error: 'currency must be a three-letter code' };
    data.currency = code ?? 'SEK';
  }

  if (given('dimensions') || !partial) {
    const dimensions = jsonObject(body.dimensions, DIMENSIONS_MAX_JSON);
    if (dimensions === undefined) {
      return { error: `dimensions must be an object of at most ${DIMENSIONS_MAX_JSON} characters as JSON` };
    }
    data.dimensions = dimensions;
  }

  if (given('keywords') || !partial) {
    const keywords = textList(body.keywords, TAG_LIMITS);
    if (!keywords) return { error: tagsError('keywords') };
    data.keywords = keywords;
  }

  if (partial && given('bought')) {
    if (typeof body.bought !== 'boolean') return { error: 'bought must be a boolean' };
    data.bought = body.bought;
  }

  return { data };
}

module.exports = { normaliseWishlistInput };
