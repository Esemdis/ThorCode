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

module.exports = { ticketState, saleDay };
