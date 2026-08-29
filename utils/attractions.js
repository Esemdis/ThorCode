// Tidying a Ticketmaster attraction search before it is shown as a list of
// bands to add.

/**
 * Attractions with same-name duplicates collapsed, keeping the live one.
 *
 * Ticketmaster's catalogue carries more than one attraction for the same act —
 * re-registrations under a new promoter, mostly. A search for "augustine"
 * returns two "Augustine" records with different ids and images, and a search
 * for "architects" returns the touring one alongside a dead record with no
 * events. Both look identical in a dropdown, so the list reads as broken.
 *
 * The survivor is the one with the most upcoming events, because that is the
 * record whose id will actually return concerts when the band is ingested. On
 * a tie the first wins: Ticketmaster returns results in relevance order.
 *
 * Matching is on the **exact** name, deliberately. canonicalBandName strips a
 * trailing parenthetical, which would merge "Architects" into
 * "Architects (UK)" — two separate acts with separate tours, five upcoming
 * shows between them. Only case and surrounding whitespace are ignored.
 *
 * @param {object[]} attractions - In Ticketmaster's relevance order.
 * @returns {object[]} One per name, still in that order.
 */
function collapseDuplicates(attractions) {
  const bestIndexByName = new Map();
  const out = [];

  for (const attraction of attractions ?? []) {
    const key = String(attraction?.name ?? '').trim().toLowerCase();
    const events = Number(attraction?.upcomingEvents) || 0;

    if (!bestIndexByName.has(key)) {
      bestIndexByName.set(key, out.length);
      out.push(attraction);
      continue;
    }

    // Replace in place rather than appending, so the survivor keeps the
    // position its best-ranked duplicate held.
    const at = bestIndexByName.get(key);
    if (events > (Number(out[at]?.upcomingEvents) || 0)) out[at] = attraction;
  }

  return out;
}

module.exports = { collapseDuplicates };
