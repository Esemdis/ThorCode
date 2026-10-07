const { Resend } = require("resend");
const { escapeHtml, safeHref } = require("./html");

let resend;
function getResend() {
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

function fmtDate(date) {
  if (!date) return "Date TBA";
  return new Date(date).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Every field here comes from a scraper — band names, venues, event links —
// and went into the email as raw HTML: an event name with a tag in it was
// markup in someone's inbox, and a link was whatever the page said it was.
function buildDigestHtml(items) {
  const rows = items
    .map((c) => {
      // An act added to a show already known: the show goes by its own name,
      // a festival's bill being far too long to head the line, and the acts
      // that are new are named under it.
      const added = c.newBandNames?.length ? c.newBandNames : null;
      const heading = added && c.name ? c.name : c.bandNames.length ? c.bandNames.join(", ") : c.name || "Concert";
      const title = escapeHtml(heading);
      const href = c.url ? safeHref(c.url) : null;
      const link = href ? `<a href="${escapeHtml(href)}">${title}</a>` : title;
      const where = [c.venue, c.city, c.country].filter(Boolean).map(escapeHtml).join(", ");
      const news = added ? `<br>New on the bill: ${escapeHtml(added.join(", "))}` : "";
      return `<li><strong>${link}</strong> — ${fmtDate(c.date)} @ ${where}${news}</li>`;
    })
    .join("");
  return `<p>New concerts matching your subscriptions:</p><ul>${rows}</ul>`;
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
        ? `New on ${only.name || only.venue}: ${only.newBandNames.join(", ")}`
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

// One line per show a follower is being told about: what happened, then the
// show, then where to buy. `alert` is the line's own words — "Sold out", or
// "New on the bill: Ghost, Opeth" — and need not be one of a fixed set;
// `tickets` is the listing to link to, named after its site.
function buildTicketAlertHtml(items) {
  const rows = items
    .map((c) => {
      const href = c.url ? safeHref(c.url) : null;
      const title = escapeHtml(c.title || "Concert");
      const link = href ? `<a href="${escapeHtml(href)}">${title}</a>` : title;
      const where = [c.venue, c.city, c.country].filter(Boolean).map(escapeHtml).join(", ");
      const ticketHref = c.tickets?.url ? safeHref(c.tickets.url) : null;
      const tickets = ticketHref
        ? ` — <a href="${escapeHtml(ticketHref)}">${escapeHtml(c.tickets.label || "Tickets")} →</a>`
        : "";
      return `<li><strong>${escapeHtml(c.alert)}:</strong> ${link} — ${fmtDate(c.date)} @ ${where}${tickets}</li>`;
    })
    .join("");
  return `<p>News about the shows you follow:</p><ul>${rows}</ul>`;
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
