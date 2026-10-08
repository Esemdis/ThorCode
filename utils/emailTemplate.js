/**
 * The look of the notification emails.
 *
 * Both of them used to be a `<p>` and a `<ul>`: a festival that gained five
 * acts arrived as one line of comma-separated names, with the bill it joined
 * nowhere in sight, so nothing in the email said which acts were the news and
 * which you had known about for months. The shell and the card here are the
 * shared answer — one layout for the scrape digest and the follow alerts
 * (utils/mail.js), with the bill split into what just joined and what was
 * already announced, and the acts you actually follow marked in both.
 *
 * Email HTML is its own dialect: tables for layout, every colour written inline
 * because most clients drop a stylesheet, and the handful that change in dark
 * mode repeated in a `<style>` block for the clients that honour it. Nothing
 * here needs a client to be clever — the labels carry the meaning and the
 * colours only make it quicker to read, so a client that strips all of it still
 * says which acts are new.
 *
 * The palette is concert-map's own (src/index.css), so an email looks like the
 * app it came from.
 */
const { escapeHtml, safeHref } = require("./html");
const { canonicalBandName } = require("./lineupNames");
const { countryFlag } = require("./countries");

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// concert-map's light theme. The dark equivalents live in the media query
// below, keyed by class, because no client lets an inline style vary by scheme.
const C = {
  page: "#f6f7f9",
  card: "#ffffff",
  border: "#e5e7eb",
  text: "#0f172a",
  muted: "#6b7280",
  faint: "#9ca3af",
  accent: "#2563eb",
  newBg: "#eff6ff",
  newBorder: "#bfdbfe",
  newText: "#1d4ed8",
  mineBg: "#dcfce7",
  mineBorder: "#bbf7d0",
  mineText: "#15803d",
  noteBg: "#fff7ed",
  noteBorder: "#fed7aa",
  noteText: "#c2410c",
};

// Acts you follow are marked rather than listed apart: a bill reads in the
// order the sources give it, and pulling your own out of that order loses which
// day or stage they sit on.
const STAR = "★";

// A bill can run to forty acts and an email is not the place to print all of
// them twice over. The news is named in full up to a generous cap; the bill
// already announced is a reminder, so it is cut shorter.
const NEW_ACTS_MAX = 30;
const KEPT_ACTS_MAX = 40;

// Up to this many acts read as chips; beyond it they become a line of text,
// because sixty chips is a wall nobody scans. A new show's bill is a handful of
// acts and a festival's is not.
const CHIP_LIMIT = 10;

function fmtDate(date) {
  if (!date) return "Date TBA";
  return new Date(date).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * The acts on this bill that the reader follows, as a Set of canonical names.
 *
 * Canonical because the bill carries whatever each source wrote — "Architects
 * (UK)" against a band row saying "Architects" — and that disambiguator is the
 * single most common reason a wishlisted act would go unmarked. See
 * utils/lineupNames.js.
 */
function followedKeys(names) {
  return new Set((names ?? []).map(canonicalBandName).filter(Boolean));
}

const isYours = (name, keys) => keys.size > 0 && keys.has(canonicalBandName(name));

function chip(name, { yours, news }) {
  const [bg, border, color] = yours
    ? [C.mineBg, C.mineBorder, C.mineText]
    : news
      ? [C.newBg, C.newBorder, C.newText]
      : ["#f3f4f6", C.border, "#111827"];
  const cls = yours ? "chip chip-mine" : news ? "chip chip-new" : "chip";
  return `<span class="${cls}" style="display:inline-block;margin:0 6px 7px 0;padding:5px 11px;border:1px solid ${border};border-radius:999px;background:${bg};color:${color};font:600 13px/1.3 ${FONT};white-space:nowrap">${yours ? `${STAR} ` : ""}${escapeHtml(name)}</span>`;
}

// One act per chip, which is what makes a short list of new names read as the
// headline it is.
function chipRow(names, keys, { news }) {
  return names.map((name) => chip(name, { yours: isYours(name, keys), news })).join("");
}

// The same names as one wrapped line, for a bill too long to chip. Yours stay
// bold and starred, so a forty-act lineup still answers "anyone I follow?" at a
// glance.
function nameRow(names, keys, { news }) {
  const parts = names.map((name) => {
    const text = escapeHtml(name);
    if (isYours(name, keys)) {
      return `<span class="you" style="color:${C.mineText};font-weight:700">${STAR} ${text}</span>`;
    }
    if (news) return `<span class="t" style="color:${C.text};font-weight:600">${text}</span>`;
    return text;
  });
  return `<span class="m" style="color:${C.muted};font:400 13px/1.9 ${FONT}">${parts.join(", ")}</span>`;
}

function actBlock({ label, names, keys, news, max }) {
  if (names.length === 0) return "";
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  const body = shown.length <= CHIP_LIMIT ? chipRow(shown, keys, { news }) : nameRow(shown, keys, { news });
  const more = rest > 0
    ? `<span class="f" style="color:${C.faint};font:400 13px/1.9 ${FONT}">${shown.length <= CHIP_LIMIT ? "" : ", "}and ${rest} more</span>`
    : "";
  return `<div style="margin-top:16px">
      <div class="m" style="color:${C.muted};font:700 11px/1.4 ${FONT};letter-spacing:.09em;text-transform:uppercase">${escapeHtml(label)} &middot; ${names.length}</div>
      <div style="margin-top:8px">${body}${more}</div>
    </div>`;
}

/**
 * One show, as a card.
 *
 * @param {object} show
 * @param {string} show.title - What to head the card with: the festival, or the acts.
 * @param {string|null} [show.url] - The listing the title links to.
 * @param {Date|string|null} [show.date]
 * @param {string|null} [show.venue]
 * @param {string|null} [show.city]
 * @param {string|null} [show.country] - ISO code; becomes a flag beside the date.
 * @param {string|null} [show.note] - What happened, where that is not the acts:
 *   "Sold out", "On sale at 11:00".
 * @param {string[]} [show.newActs] - The acts that are news.
 * @param {string[]} [show.keptActs] - The rest of the bill.
 * @param {string[]} [show.yourActs] - The reader's own bands, marked wherever they appear.
 * @param {{url: string, label: string}|null} [show.tickets]
 * @returns {string}
 */
function showCard({ title, url, date, venue, city, country, note, newActs = [], keptActs = [], yourActs = [], tickets = null }) {
  const keys = followedKeys(yourActs);
  const heading = escapeHtml(title || "Concert");
  const href = url ? safeHref(url) : null;
  const headline = href
    ? `<a class="link" href="${escapeHtml(href)}" style="color:${C.accent};text-decoration:none">${heading}</a>`
    : heading;

  const flag = countryFlag(country);
  const where = [venue, city, country].filter(Boolean).map(escapeHtml).join(", ");
  const whenWhere = [`${flag ? `${flag} ` : ""}${escapeHtml(fmtDate(date))}`, where].filter(Boolean).join(" &middot; ");

  const pill = note
    ? `<div style="margin-top:12px"><span class="pill" style="display:inline-block;padding:4px 10px;border:1px solid ${C.noteBorder};border-radius:6px;background:${C.noteBg};color:${C.noteText};font:700 12px/1.4 ${FONT}">${escapeHtml(note)}</span></div>`
    : "";

  // A show nobody has been told about yet has no split to show: the whole bill
  // is the news, and calling half of it "already announced" would be a lie.
  const sections = newActs.length > 0
    ? actBlock({ label: "New on the bill", names: newActs, keys, news: true, max: NEW_ACTS_MAX })
      + actBlock({ label: "Already announced", names: keptActs, keys, news: false, max: KEPT_ACTS_MAX })
    : actBlock({ label: "On the bill", names: keptActs, keys, news: true, max: KEPT_ACTS_MAX });

  const legend = keys.size > 0 && [...newActs, ...keptActs].some((name) => isYours(name, keys))
    ? `<div class="f" style="margin-top:14px;color:${C.faint};font:400 12px/1.5 ${FONT}">${STAR} on your wishlist</div>`
    : "";

  const buy = tickets?.url && safeHref(tickets.url)
    ? `<div style="margin-top:16px"><a class="link" href="${escapeHtml(safeHref(tickets.url))}" style="color:${C.accent};font:700 14px/1.4 ${FONT};text-decoration:none">&#127915; ${escapeHtml(tickets.label || "Tickets")} &rarr;</a></div>`
    : "";

  return `<table class="card" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;background:${C.card};border:1px solid ${C.border};border-radius:12px">
    <tr><td style="padding:20px 22px">
      <div class="t" style="color:${C.text};font:700 19px/1.35 ${FONT}">${headline}</div>
      <div class="m" style="margin-top:6px;color:${C.muted};font:400 13px/1.5 ${FONT}">${whenWhere}</div>
      ${pill}${sections}${legend}${buy}
    </td></tr>
  </table>`;
}

// Only the colours a dark client has to override, and only on the classes the
// markup above sets. Gmail and Apple Mail honour this; the ones that do not
// keep the light card, which is still readable rather than broken.
const DARK = `
    @media (prefers-color-scheme: dark) {
      .page { background:#0b0d12 !important; }
      .card { background:#131722 !important; border-color:#1f2937 !important; }
      .t, .t a { color:#e5e7eb !important; }
      .m { color:#9aa3af !important; }
      .f { color:#6b7280 !important; }
      .link { color:#60a5fa !important; }
      .chip { background:rgba(255,255,255,0.06) !important; border-color:rgba(255,255,255,0.14) !important; color:#e5e7eb !important; }
      .chip-new { background:#172554 !important; border-color:#1d4ed8 !important; color:#bfdbfe !important; }
      .chip-mine { background:#052e1c !important; border-color:#166534 !important; color:#86efac !important; }
      .you { color:#86efac !important; }
      .pill { background:#2a1a0c !important; border-color:#7c2d12 !important; color:#fb923c !important; }
    }
    @media (max-width:600px) {
      .card td { padding:16px 16px !important; }
    }`;

/**
 * The document around a set of cards.
 *
 * @param {object} mail
 * @param {string} mail.heading - The line above the cards; the subject in words.
 * @param {string} [mail.preheader] - What the inbox shows beside the subject.
 * @param {string[]} mail.cards - Rendered cards, in order.
 * @param {string} [mail.footnote] - Why this email arrived.
 * @returns {string}
 */
function emailShell({ heading, preheader, cards, footnote }) {
  const rows = cards.map((card) => `<tr><td style="padding:0 0 14px">${card}</td></tr>`).join("");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(heading)}</title>
<style>${DARK}</style>
</head>
<body class="page" style="margin:0;padding:0;width:100%;background:${C.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader || heading)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="page" style="background:${C.page}">
  <tr><td align="center" style="padding:28px 12px 36px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
      <tr><td style="padding:0 2px 6px">
        <div class="f" style="color:${C.faint};font:700 11px/1.4 ${FONT};letter-spacing:.14em;text-transform:uppercase">Concert Map</div>
      </td></tr>
      <tr><td style="padding:0 2px 18px">
        <div class="t" style="color:${C.text};font:700 22px/1.3 ${FONT}">${escapeHtml(heading)}</div>
      </td></tr>
      ${rows}
      ${footnote ? `<tr><td style="padding:10px 2px 0">
        <div class="f" style="color:${C.faint};font:400 12px/1.6 ${FONT}">${escapeHtml(footnote)}</div>
      </td></tr>` : ""}
    </table>
  </td></tr>
</table>
</body></html>`;
}

/**
 * A few names for a subject line, counting the rest.
 *
 * A subject naming thirty acts is a subject nothing can read, and the inbox cuts
 * it wherever it likes rather than where the meaning is.
 *
 * @param {string[]} names
 * @param {number} [max]
 * @returns {string}
 */
function nameSummary(names, max = 3) {
  const list = (names ?? []).filter(Boolean);
  if (list.length === 0) return "";
  const shown = list.slice(0, max);
  const rest = list.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest} more` : shown.join(", ");
}

module.exports = { emailShell, showCard, nameSummary, fmtDate };
