/**
 * Validate and normalise what a client sends when creating or editing a piece
 * of gear.
 *
 * The gear routes parsed their bodies inline, twice, and trusted the types: a
 * price or fill level that was not a number reached Prisma as NaN, a name over
 * the column's 200 characters or a currency longer than three letters failed
 * in Postgres, and a number where text was expected threw on .trim() — each of
 * them a 500 with nothing to say what was wrong. Same shape as tripInput.js —
 * `{ data }` or `{ error }` — so the routes answer 400 with a sentence the app
 * can show.
 *
 * `partial` separates a PATCH from a POST: on a create, absent fields take
 * their defaults; on an update, absent fields stay absent so they are not
 * overwritten with them. replaced_by_id is not here: it needs the database to
 * check, and the route does that.
 */
const {
  INT32_MAX, INT32_MIN, DECIMAL_MAX, NOTE_MAX_LENGTH, TAG_LIMITS, DIMENSIONS_MAX_JSON,
  text, number, currency, textList, tagsError, jsonObject,
} = require('./fields');
const { photoDataUrl, PHOTO_TOO_LARGE, GEAR_PHOTO_MAX_LENGTH } = require('./photo');

// Kept under its old name: callers and tests import it from here.
const PHOTO_MAX_LENGTH = GEAR_PHOTO_MAX_LENGTH;

// Column widths, from schema.prisma.
const TEXT_FIELDS = [['model', 200], ['brand', 100], ['category', 100], ['url', 500]];
const PRICE_FIELDS = ['retail_price', 'bought_for'];
const FLAGS = ['worn', 'essential', 'retired', 'price_irrelevant'];
// Absent on a create means false, as the columns' own defaults say. Only these
// two were ever written on a create; essential and retired start at theirs.
const CREATE_FLAGS = ['worn', 'price_irrelevant'];
// Same ceiling as a trip item's per_day, which this is copied onto.
const PER_DAY_MAX = 1000;
// A medicine container's list (THO-1063): at most this many medicines, each
// taken at most every this many days.
const CONTENTS_MAX = 30;
const EVERY_DAYS_MAX = 365;

/**
 * What a medicine container holds, as `[{ name, amount, every_days }]`, or
 * undefined when it does not parse. Nothing sent means an empty list: Prisma
 * refuses a plain null for a Json column, and [] reads the same to the app.
 */
function gearContents(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > CONTENTS_MAX) return undefined;
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return undefined;
    const name = text(entry.name, 100);
    const amount = number(entry.amount, { min: 1, max: PER_DAY_MAX, integer: true });
    const everyDays = entry.every_days == null ? 1 : number(entry.every_days, { min: 1, max: EVERY_DAYS_MAX, integer: true });
    if (!name || amount == null || everyDays == null) return undefined;
    out.push({ name, amount, every_days: everyDays });
  }
  return out;
}

function normaliseGearInput(body = {}, { partial = false } = {}) {
  const data = {};
  const given = (field) => body[field] !== undefined;

  if (given('name') || !partial) {
    const name = text(body.name, 200);
    if (!name) return { error: 'A gear item needs a name of at most 200 characters' };
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

  if (given('photo') || !partial) {
    const photo = photoDataUrl(body.photo, PHOTO_MAX_LENGTH);
    if (photo === PHOTO_TOO_LARGE) return { error: 'Photo too large — compress it below ~220KB' };
    if (photo === undefined) return { error: 'Photo must be a JPEG, PNG or WebP image data URL' };
    data.photo = photo;
  }

  // Free-form measurements ({ height, width, weight, … }), read by the app's
  // weight and volume totals. An object or nothing; a list or a bare number
  // would be stored and then silently counted as unmeasured.
  if (given('dimensions') || !partial) {
    const dimensions = jsonObject(body.dimensions, DIMENSIONS_MAX_JSON);
    if (dimensions === undefined) {
      return { error: `dimensions must be an object of at most ${DIMENSIONS_MAX_JSON} characters as JSON` };
    }
    data.dimensions = dimensions;
  }

  if (given('tags') || !partial) {
    const tags = textList(body.tags, TAG_LIMITS);
    if (!tags) return { error: tagsError('tags') };
    data.tags = tags;
  }

  for (const field of PRICE_FIELDS) {
    if (!given(field) && partial) continue;
    const amount = number(body[field], { max: DECIMAL_MAX });
    if (amount === undefined) return { error: `${field} must be an amount from 0 to ${DECIMAL_MAX}` };
    data[field] = amount;
  }

  // Empty means the default, on an edit as on a create: the form sends
  // whatever its currency box holds.
  if (given('currency') || !partial) {
    const code = currency(body.currency);
    if (code === undefined) return { error: 'currency must be a three-letter code' };
    data.currency = code ?? 'SEK';
  }

  // A percentage, kept to 0–100 rather than refused outside it: it comes off a
  // slider, and the ends are what a slightly-off value means. Whole percent,
  // cut rather than rounded, as it always was.
  if (given('fill_level') || !partial) {
    const level = number(body.fill_level, { min: -Infinity });
    if (level === undefined) return { error: 'fill_level must be a percentage' };
    data.fill_level = level === null ? null : Math.max(0, Math.min(100, Math.trunc(level)));
  }

  // The daily dose a medicine is packed for, copied onto the trip item when the
  // gear lands on a trip. Only set when sent: most gear has none, and the form
  // only shows the field for medicine, so a create leaves it to the column.
  if (given('per_day')) {
    const perDay = number(body.per_day, { min: 1, max: PER_DAY_MAX, integer: true });
    if (perDay === undefined) return { error: `per_day must be a whole number from 1 to ${PER_DAY_MAX}, or null` };
    data.per_day = perDay;
  }

  // Only set when sent, as per_day: a create without it leaves the column empty.
  if (given('contents')) {
    const contents = gearContents(body.contents);
    if (contents === undefined) {
      return { error: `contents must be a list of at most ${CONTENTS_MAX} medicines, each with a name, an amount from 1 to ${PER_DAY_MAX} and every_days from 1 to ${EVERY_DAYS_MAX}` };
    }
    data.contents = contents;
  }

  if (given('sort_order')) {
    const position = number(body.sort_order, { min: INT32_MIN, max: INT32_MAX, integer: true });
    if (position == null) return { error: 'sort_order must be a whole number' };
    data.sort_order = position;
  }

  for (const field of FLAGS) {
    if (given(field) || (!partial && CREATE_FLAGS.includes(field))) data[field] = Boolean(body[field]);
  }

  return { data };
}

module.exports = { normaliseGearInput, PHOTO_MAX_LENGTH };
