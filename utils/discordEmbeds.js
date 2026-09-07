/**
 * Discord embeds for a set of new concerts.
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

    let lineup = [];
    try { lineup = JSON.parse(concert.metadata || "[]"); } catch {}
    const fullLineup = lineup.length ? `\n${lineup.join(", ")}` : "";
    const maxLineup = FIELD_VALUE_LIMIT - venueStr.length - 1;
    const lineupStr = fullLineup.length > maxLineup ? fullLineup.slice(0, maxLineup) + "…" : fullLineup;

    fields.push({ name: label, value: venueStr + lineupStr, inline: false });
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

module.exports = { buildDiscordEmbeds };
