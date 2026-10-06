/**
 * Discord embeds for a set of new concerts, and for a week's recap of them.
 *
 * Extracted from routes/data/wishlists/notify.js when a second caller appeared:
 * the wishlist digest titles its embed after a band, while the subscription
 * post covers whatever the user happens to watch and has no single band to name
 * — hence the title being passed in rather than derived from one.
 *
 * The limits below are Discord's, and exceeding any of them fails the whole
 * POST rather than truncating it, so the splitting here is what keeps a busy
 * announcement from silently not arriving.
 */

const { countryFlag } = require("./countries");

// 6000 is the real cap across an embed; 5800 leaves room for the title and
// footer that are added after the fields are measured.
const EMBED_CHAR_LIMIT = 5800;
const FIELD_VALUE_LIMIT = 1024;
const FIELD_NAME_LIMIT = 256;
const MAX_FIELDS = 25;

function buildDiscordEmbeds({ title, concerts }) {
  const fields = [];

  for (const concert of concerts ?? []) {
    const date = concert.concert_date
      ? new Date(concert.concert_date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
      : "TBA";
    const location = [concert.city, concert.country].filter(Boolean).join(", ");
    const venue = concert.venue || "Unknown venue";
    const rawLabel = `${date} — ${location}`;
    const label = rawLabel.length > FIELD_NAME_LIMIT ? rawLabel.slice(0, FIELD_NAME_LIMIT - 1) + "…" : rawLabel;
    const venueStr = concert.url ? `[${venue}](${concert.url})` : venue;
    // An act joining a show already announced: which acts are the news, ahead
    // of a festival's lineup that can run to the field's limit.
    const added = Array.isArray(concert.new_acts) && concert.new_acts.length
      ? `\n**New on the bill:** ${concert.new_acts.map(escapeMarkdown).join(", ")}`
      : "";
    // What is being said about the show, for a post about more than one
    // thing: "Sold out", "On sale today".
    const note = typeof concert.note === "string" && concert.note ? `\n**${escapeMarkdown(concert.note.slice(0, 100))}**` : "";
    const head = venueStr + note + (added.length > 300 ? `${added.slice(0, 299)}…` : added);

    let lineup = [];
    try { lineup = JSON.parse(concert.metadata || "[]"); } catch {}
    // metadata is free-form text. Anything but a list of names threw on
    // .join, outside the post's own try, and took the whole notify run down.
    if (!Array.isArray(lineup)) lineup = [];
    lineup = lineup.filter((n) => typeof n === "string");
    const fullLineup = lineup.length ? `\n${lineup.join(", ")}` : "";
    const maxLineup = FIELD_VALUE_LIMIT - head.length - 1;
    const lineupStr = fullLineup.length > maxLineup ? fullLineup.slice(0, maxLineup) + "…" : fullLineup;

    fields.push({ name: label, value: head + lineupStr, inline: false });
  }

  const footer = `${fields.length} new concert${fields.length !== 1 ? "s" : ""}`;
  const baseChars = title.length + footer.length;

  const embeds = [];
  let current = [];
  let currentChars = baseChars;

  for (const field of fields) {
    const fieldChars = field.name.length + field.value.length;
    if (current.length > 0 && (currentChars + fieldChars > EMBED_CHAR_LIMIT || current.length >= MAX_FIELDS)) {
      embeds.push({ title, color: 0x5865f2, fields: current, footer: { text: footer } });
      current = [];
      currentChars = baseChars;
    }
    current.push(field);
    currentChars += fieldChars;
  }

  if (current.length > 0 || embeds.length === 0) {
    embeds.push({ title, color: 0x5865f2, fields: current, footer: { text: footer } });
  }

  return embeds;
}

// Room left for the "+N more cities" field that closes a long recap.
const OVERFLOW_RESERVE = 80;
// Long enough for a busy week's bands, short enough to leave the cities
// most of the embed.
const BAND_LIST_LIMIT = 1800;
const CITY_LIST_LIMIT = 300;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Discord reads band names as markdown: one with an asterisk or an underscore
// in it would set the rest of the list in italics.
const escapeMarkdown = (text) => String(text).replace(/([\\*_~`|>])/g, "\\$1");

/**
 * As many items as fit in `max` characters, with what did not fit counted at
 * the end: "Ghost, Opeth and 12 more".
 *
 * @param {string[]} items
 * @param {number} max
 * @param {{sep?: string, more?: (n: number) => string}} [options]
 */
function listWithin(items, max, { sep = ", ", more = (n) => ` and ${n} more` } = {}) {
  let out = "";
  for (const [i, item] of items.entries()) {
    const next = out ? `${out}${sep}${item}` : item;
    const left = items.length - i - 1;
    if (next.length + (left > 0 ? more(left).length : 0) > max) {
      // The check one item back made room for exactly this tail.
      return out ? `${out}${more(items.length - i)}` : `${item.slice(0, max - 1)}…`;
    }
    out = next;
  }
  return out;
}

// Spelled out rather than asked of Intl, whose en-GB says "Sep" or "Sept"
// depending on the ICU the server's Node was built with.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "28 Sep – 4 Oct 2026", "5–11 Oct 2026", or across a new year in full. The
// days are plain "YYYY-MM-DD" dates, read as written.
function dayRange(first, last) {
  const [a, b] = [first, last].map((day) => day.split("-").map(Number));
  const dayMonth = ([, m, d]) => `${d} ${MONTHS[m - 1]}`;
  const full = (date) => `${dayMonth(date)} ${date[0]}`;
  if (a[0] !== b[0]) return `${full(a)} – ${full(b)}`;
  if (a[1] !== b[1]) return `${dayMonth(a)} – ${full(b)}`;
  return `${a[2]}–${full(b)}`;
}

// One show's day, read in UTC as concert_date is filed.
function dayLabel(date) {
  if (!date) return "Date TBA";
  const d = new Date(date);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// "**12 Mar 2027** — Ghost, Opeth": when, and which of your bands.
const showLine = (concert) =>
  `**${dayLabel(concert.concert_date)}** — ${concert.bands.map((b) => escapeMarkdown(b.name)).join(", ")}`;

// The flag says the country, so the city's name can stand alone after it.
function cityLabel({ city, country }) {
  return `${countryFlag(country)} ${escapeMarkdown(city || "Unknown city")}`.trim();
}

/**
 * One embed for a week's recap (see utils/weeklyRecap.js): the total, every
 * band with its count, and a field per city with its shows, one to a line.
 *
 * Cities are added biggest first until the embed is full, and the rest are
 * summed in one last field, so a busy week is cut short rather than refused.
 */
function buildRecapEmbed(recap) {
  const title = `Week ${recap.week}: ${plural(recap.total, "new concert", "new concerts")}`;
  const counted = (b) => `**${escapeMarkdown(b.name)}**${b.count > 1 ? ` (${b.count})` : ""}`;

  const where = plural(recap.cities.length, "city", "cities")
    + (recap.country_count > 0 ? ` in ${plural(recap.country_count, "country", "countries")}` : "");
  const heading = `${dayRange(recap.first_day, recap.last_day)} · ${where}`;
  const bands = listWithin(recap.bands.map(counted), BAND_LIST_LIMIT);
  const description = bands ? `${heading}\n\n${bands}` : heading;

  const fields = [];
  let used = title.length + description.length;
  for (const [i, city] of recap.cities.entries()) {
    const name = `${cityLabel(city)} · ${city.count}`;
    const value = listWithin(city.concerts.map(showLine), CITY_LIST_LIMIT, {
      sep: "\n", more: (n) => `\n+${plural(n, "more show", "more shows")}`,
    }) || "—";
    const last = i === recap.cities.length - 1;
    const full = fields.length === MAX_FIELDS - 1 && !last;
    if (full || used + name.length + value.length + (last ? 0 : OVERFLOW_RESERVE) > EMBED_CHAR_LIMIT) {
      const rest = recap.cities.slice(i);
      fields.push({
        name: `+${plural(rest.length, "more city", "more cities")}`,
        value: plural(rest.reduce((sum, c) => sum + c.count, 0), "concert", "concerts"),
        inline: false,
      });
      break;
    }
    fields.push({ name, value, inline: false });
    used += name.length + value.length;
  }

  return { title, description, color: 0x5865f2, fields };
}

module.exports = { buildDiscordEmbeds, buildRecapEmbed };
