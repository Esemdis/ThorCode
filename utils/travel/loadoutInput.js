/**
 * Validate and normalise what a client sends when creating or renaming a
 * loadout. A weight budget that was not a whole number reached Prisma as NaN,
 * and a name that was not text threw on .trim() — both 500s. Same `{ data }`
 * or `{ error }` shape as tripInput.js.
 */
const { INT32_MAX, text, number } = require('./fields');

function normaliseLoadoutInput(body = {}, { partial = false } = {}) {
  const data = {};
  const given = (field) => body[field] !== undefined;

  if (given('name') || !partial) {
    const name = text(body.name, 200);
    if (!name) return { error: 'A loadout needs a name of at most 200 characters' };
    data.name = name;
  }

  if (given('description') || !partial) {
    const description = text(body.description);
    if (description === undefined) return { error: 'description must be text' };
    data.description = description;
  }

  if (given('weight_budget') || !partial) {
    const grams = number(body.weight_budget, { max: INT32_MAX, integer: true });
    if (grams === undefined) return { error: 'weight_budget must be a whole number of grams' };
    data.weight_budget = grams;
  }

  return { data };
}

module.exports = { normaliseLoadoutInput };
