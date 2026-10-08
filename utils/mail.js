const { Resend } = require("resend");
const { canonicalBandName } = require("./lineupNames");
// What the two notification emails look like, shared so they look like one
// another and like the app. See utils/emailTemplate.js for the dialect.
const { emailShell, showCard, nameSummary } = require("./emailTemplate");

let resend;
function getResend() {
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

// Why this email arrived, in the small print under the cards.
const WATCH_FOOTER = "You're getting this because of the artists, cities and festivals you watch on Concert Map.";
const FOLLOW_FOOTER = "You're getting this because you follow these shows on Concert Map.";

/**
 * The bill, split into what is news for this reader and what is not.
 *
 * Compared on the canonical name rather than the literal string: the acts that
 * joined come off the Band rows that were linked, the bill carries whatever
 * each source wrote, and "Architects" against "Architects (UK)" would otherwise
 * be listed as both new and already announced.
 */
function splitBill(bill, added) {
  const news = (added ?? []).filter(Boolean);
  if (news.length === 0) return { news, kept: bill };
  const keys = new Set(news.map(canonicalBandName).filter(Boolean));
  return { news, kept: bill.filter((name) => !keys.has(canonicalBandName(name))) };
}

// Every field here comes from a scraper — band names, venues, event links —
// and went into the email as raw HTML: an event name with a tag in it was
// markup in someone's inbox, and a link was whatever the page said it was.
// showCard escapes all of it.
function buildDigestHtml(items) {
  const cards = items.map((c) => {
    const { news, kept } = splitBill(c.bandNames ?? [], c.newBandNames);
    // An act added to a show already known: the show goes by its own name, a
    // festival's bill being far too long to head the line, and the acts that
    // are new are named under it.
    const title = news.length > 0 && c.name ? c.name : nameSummary(c.bandNames ?? [], 4) || c.name || "Concert";
    return showCard({
      title,
      url: c.url,
      date: c.date,
      venue: c.venue,
      city: c.city,
      country: c.country,
      newActs: news,
      keptActs: kept,
      yourActs: c.yourBandNames,
    });
  });

  const [only] = items;
  const added = items.length === 1 ? (only.newBandNames ?? []).filter(Boolean) : [];
  const heading = items.length !== 1
    ? `${items.length} shows matching your watches`
    : added.length > 0
      ? `${added.length === 1 ? "An act has" : `${added.length} acts have`} joined a show you watch`
      : "A new show matching your watches";
  const preheader = items.length === 1 && added.length > 0
    ? `${nameSummary(added)} — ${only.name || only.venue || "a show you watch"}`
    : undefined;

  return emailShell({ heading, preheader, cards, footnote: WATCH_FOOTER });
}

/**
 * Send one user's digest. Throws when it was not sent.
 *
 * Resend does not throw on a failed send — it resolves `{ data: null, error }`
 * for a bad key, an unverified sender, a rate limit or the network — and this
 * never looked, so every failure was counted as a digest delivered.
 */
async function sendDigestEmail({ to, items }) {
  const [only] = items;
  const subject =
    items.length !== 1
      ? `${items.length} new concerts matching your subscriptions`
      : only.newBandNames?.length
        ? `New on ${only.name || only.venue}: ${nameSummary(only.newBandNames)}`
        : `New concert: ${only.bandNames[0] || only.name}`;

  const result = await getResend().emails.send({
    from: process.env.NOTIFICATIONS_FROM_EMAIL,
    to,
    subject,
    html: buildDigestHtml(items),
  });
  if (result?.error) {
    throw new Error(`Email service error: ${result.error.message ?? result.error.name ?? "unknown"}`);
  }
  return result;
}

// One card per show a follower is being told about: what happened, the show,
// and where to buy. `alert` is the line's own words — "Sold out", or "New on
// the bill: Ghost, Opeth" — and need not be one of a fixed set; `tickets` is
// the listing to link to, named after its site.
//
// An item about the bill carries `acts` as well, and then the card names those
// acts itself, under the bill they joined and beside the bill they joined it on
// — so `alert`, which says the same thing in one line, is left to Discord and
// to the subject.
function buildTicketAlertHtml(items) {
  const cards = items.map((c) => {
    const { news, kept } = splitBill(c.acts?.bill ?? [], c.acts?.joined);
    return showCard({
      title: c.title || "Concert",
      url: c.url,
      date: c.date,
      venue: c.venue,
      city: c.city,
      country: c.country,
      note: news.length > 0 ? null : c.alert,
      newActs: news,
      keptActs: news.length > 0 ? kept : [],
      yourActs: c.yourBandNames,
      tickets: c.tickets,
    });
  });

  const [only] = items;
  const heading = items.length === 1
    ? (only.headline ?? `${only.alert}: ${only.title}`)
    : `News about ${items.length} shows you follow`;

  return emailShell({ heading, preheader: items.length === 1 ? only.alert : undefined, cards, footnote: FOLLOW_FOOTER });
}

/**
 * Tell a follower what their shows are doing — tickets, or an act joining a
 * bill. Throws when it was not sent, as sendDigestEmail does.
 *
 * A single item's subject is its `headline` where it has one: a line that
 * already names the acts that joined would make a subject nothing could read.
 */
async function sendTicketAlertEmail({ to, items }) {
  const [only] = items;
  const subject = items.length === 1
    ? (only.headline ?? `${only.alert}: ${only.title}`)
    : `News about ${items.length} shows you follow`;
  const result = await getResend().emails.send({
    from: process.env.NOTIFICATIONS_FROM_EMAIL,
    to,
    subject,
    html: buildTicketAlertHtml(items),
  });
  if (result?.error) {
    throw new Error(`Email service error: ${result.error.message ?? result.error.name ?? "unknown"}`);
  }
  return result;
}

/**
 * Send email verification code
 * @param {string} to - Recipient email
 * @param {string} code - Verification code to send
 * @throws {Error} If email sending fails
 */
async function sendEmailVerificationCode({ to, code }) {
  if (!to || !code) {
    throw new Error('Email and code are required');
  }

  const html = `
    <p>You requested to change your email address. Please use the following verification code to confirm your new email:</p>
    <p style="font-size: 24px; font-weight: bold; letter-spacing: 2px; margin: 20px 0;">${code}</p>
    <p>This code will expire in 15 minutes. If you did not request this change, please ignore this email.</p>
  `;

  try {
    const result = await getResend().emails.send({
      from: process.env.NOTIFICATIONS_FROM_EMAIL,
      to,
      subject: "Verify your new email address",
      html,
    });

    if (result.error) {
      throw new Error(`Email service error: ${result.error.message}`);
    }

    return result;
  } catch (error) {
    console.error('Failed to send email verification code:', error);
    throw error;
  }
}

module.exports = { sendDigestEmail, sendEmailVerificationCode, buildDigestHtml, sendTicketAlertEmail, buildTicketAlertHtml };
