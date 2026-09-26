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
// Decimal(10, 2): eight digits before the point.
const DECIMAL_MAX = 99999999.99;

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

/** A list of non-empty trimmed strings. Undefined means it is not a list of text. */
function textList(value) {
  const list = value ?? [];
  if (!Array.isArray(list) || list.some((t) => typeof t !== 'string')) return undefined;
  return list.map((t) => t.trim()).filter(Boolean);
}

module.exports = {
  INT32_MAX, INT32_MIN, DECIMAL_MAX, blank, text, date, number, currency, textList,
};
