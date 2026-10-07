/**
 * Where a show's tickets are, from what the scrapers keep on its row.
 *
 * Its own module because the follow routes, the Festivals list and the alert
 * job all read it, and two of those have no business loading the job's
 * Discord and email clients to do so.
 */

// The sale's calendar day. Stored as midnight UTC on it, from a date alone.
const saleDay = (concert) => (concert.ticket_sale_start ? new Date(concert.ticket_sale_start).toISOString().slice(0, 10) : null);

/**
 * 'sold_out', 'on_sale', 'on_sale_soon' (a sale day today or still to come)
 * or 'unknown'.
 *
 * @param {{sold_out?: boolean|null, on_sale?: boolean|null, ticket_sale_start?: Date|string|null}} concert
 * @param {Date} [now]
 */
function ticketState(concert, now = new Date()) {
  if (concert.sold_out) return "sold_out";
  if (concert.on_sale) return "on_sale";
  const day = saleDay(concert);
  if (day && day >= now.toISOString().slice(0, 10)) return "on_sale_soon";
  return "unknown";
}

/**
 * The ticket fields to write when a scrape merges into a stored row.
 *
 * What the tickets are doing is the state of the world now, not something one
 * row owns, so a fresh scrape generally wins however short its bill. Two
 * exceptions, both because these rows come from different sources:
 *
 * - Songkick and Bandsintown each mark a listing in stock by default, so a
 *   row with nothing specific to say must not overwrite one that named the
 *   day the sale opens, nor clear that day.
 * - A sold-out show comes back only when a source says it is selling again,
 *   rather than whenever one merely fails to mention it.
 *
 * @param {object} existing - the stored row
 * @param {object} incoming - the scraped concert
 * @param {Date} [now]
 * @returns {object} the fields to update, which may be none
 */
function mergeTicketFields(existing, incoming, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const wanted = {};

  // Sold out is the one state nobody reports by default.
  if (incoming.sold_out) {
    Object.assign(wanted, { sold_out: true, on_sale: false });
  } else {
    if (incoming.sold_out === false && incoming.on_sale) wanted.sold_out = false;
    const day = saleDay(incoming);
    if (day && day >= today) {
      // A sale day still to come carries its own "not on sale yet".
      Object.assign(wanted, { ticket_sale_start: new Date(incoming.ticket_sale_start), on_sale: false });
    } else {
      const pending = saleDay(existing);
      if (!(pending && pending >= today) && incoming.on_sale !== undefined) wanted.on_sale = incoming.on_sale;
    }
  }

  // Only what is actually new. This runs for every row every scrape merges
  // into, twice a day, and writing back what is already there is still a
  // write — and, to anything watching the row, looks like news.
  const unchanged = (key, value) => {
    const was = existing[key];
    if (value instanceof Date) return was instanceof Date && was.getTime() === value.getTime();
    return (was ?? false) === value;
  };
  return Object.fromEntries(Object.entries(wanted).filter(([key, value]) => !unchanged(key, value)));
}

/**
 * Whether a stored sale date carries a time of day, rather than only a day.
 *
 * The same convention the app uses for a concert's own start: a value with no
 * time published is stored at exactly midnight UTC, so midnight is the marker
 * for "no time". No source gives a sale time today — Songkick's event page
 * names the day and nothing more — so this is false everywhere for now, and is
 * what a source that one day gives one would set.
 *
 * @param {{ticket_sale_start?: Date|string|null}} concert
 */
function saleHasTime(concert) {
  if (!concert.ticket_sale_start) return false;
  const at = new Date(concert.ticket_sale_start);
  if (Number.isNaN(at.getTime())) return false;
  return at.getUTCHours() !== 0 || at.getUTCMinutes() !== 0 || at.getUTCSeconds() !== 0;
}

module.exports = { ticketState, saleDay, saleHasTime, mergeTicketFields };
