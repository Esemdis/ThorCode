const { canonicalBandName } = require('./lineupNames');

/**
 * The stored band whose name is the same as `name` once case, punctuation,
 * accents and a country suffix are ignored — the comparison /bulk and
 * enrich-lineup already use. Band.name is unique only byte for byte, so
 * "Gojira" and "GOJIRA" are two rows to the database and one band to everyone
 * else; an add that only asked for the exact name made the second.
 *
 * Reads every band, as those two do: a canonical key cannot be put in a WHERE.
 * Lowest id wins when production already holds duplicates, so the same name
 * always answers with the same row.
 *
 * @param {object} db - prisma, or a transaction
 * @param {string} name
 * @param {object} [select] - extra fields to return; id and name always are
 */
async function findBandByCanonicalName(db, name, select = {}) {
  const key = canonicalBandName(name);
  // A name with no letters or digits has no key to compare; exact match only.
  if (!key) return db.band.findFirst({ where: { name }, select: { id: true, name: true, ...select } });
  const bands = await db.band.findMany({ select: { id: true, name: true, ...select }, orderBy: { id: 'asc' } });
  return bands.find((b) => canonicalBandName(b.name) === key) ?? null;
}

module.exports = { findBandByCanonicalName };
