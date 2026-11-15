/**
 * The small parsers every travel input normaliser is built from.
 *
 * Each one answers the value to store, null for "left empty", or undefined for
 * "not usable" — which the normaliser turns into a sentence and a 400. That
 * three-way answer is the whole point: a route that passed raw input straight
 * to Prisma answered a string in a number field, or a name too long for its
 * column, with a 500 that said nothing about what was wrong.
 *
 * Lifted out of tripInput.js, where they started, so the gear and estimate
 * normalisers make the same calls the same way.
 */

const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;
// Decimal(12, 2): ten digits before the point. It was (10, 2), and eight
// digits refused a two-week budget in dong or rupiah, where 100,000,000 is a
// few thousand euros. Every travel money column shares this bound, so it must
// move with all of them or a value passes here and overflows the column.
const DECIMAL_MAX = 9999999999.99;
// Every free-text field on a travel row (notes, descriptions, review notes).
// The wishlist's notes held this first. The columns are Text, so nothing in
// Postgres stopped a 5 MB note, and the list endpoints return up to 500 rows
// with every note in them: one write made every later read of the list slow.
const NOTE_MAX_LENGTH = 10000;
// Gear and trip tags and wishlist keywords: a word or two typed into a chip
// input, a handful per item in practice, and the form shows every one.
const TAG_LIMITS = { maxItems: 50, maxLength: 100 };
// Gear and wishlist `dimensions`: six measurements are under 200 characters of
// JSON, so ten times that fits any honest form and keeps a 500-row list small.
const DIMENSIONS_MAX_JSON = 2000;

const blank = (v) => v === null || v === undefined || v === '';

/** A string, trimmed, or null. Undefined means "not a string", or longer than `max`. */
function text(value, max) {
  if (blank(value)) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (max && trimmed.length > max) return undefined;
  return trimmed || null;
}

/** A calendar date, or null. Undefined means "does not parse". */
function date(value) {
  if (blank(value)) return null;
  if (typeof value !== 'string' && !(value instanceof Date)) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** A number from `min` to `max`, or null. Undefined means out of range or not a number. */
function number(value, { min = 0, max, integer = false } = {}) {
  if (blank(value)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || (max != null && n > max)) return undefined;
  if (integer && !Number.isInteger(n)) return undefined;
  return n;
}

/** A three-letter currency code, upper-cased, or null. Undefined means it is not one. */
function currency(value) {
  if (blank(value)) return null;
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : undefined;
}

/**
 * A list of non-empty trimmed strings. Undefined means it is not a list of
 * text, or holds more than `maxItems` entries or one longer than `maxLength`.
 * The count is of what was sent, blanks included, so the limit bounds the work
 * done on the request and not only what is stored.
 */
function textList(value, { maxItems, maxLength } = {}) {
  const list = value ?? [];
  if (!Array.isArray(list) || list.some((t) => typeof t !== 'string')) return undefined;
  if (maxItems && list.length > maxItems) return undefined;
  const trimmed = list.map((t) => t.trim());
  if (maxLength && trimmed.some((t) => t.length > maxLength)) return undefined;
  return trimmed.filter(Boolean);
}

const tagsError = (field) =>
  `${field} must be a list of at most ${TAG_LIMITS.maxItems} entries of at most ${TAG_LIMITS.maxLength} characters`;

/**
 * A plain object whose JSON is at most `maxChars` long, or null. Undefined
 * means a list, a bare value, or too large. Measured as JSON because that is
 * what lands in the Json column and comes back on every list read.
 */
function jsonObject(value, maxChars) {
  if (blank(value)) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (maxChars && JSON.stringify(value).length > maxChars) return undefined;
  return value;
}

module.exports = {
  INT32_MAX, INT32_MIN, DECIMAL_MAX, NOTE_MAX_LENGTH, TAG_LIMITS, DIMENSIONS_MAX_JSON,
  blank, text, date, number, currency, textList, tagsError, jsonObject,
};
