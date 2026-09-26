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
      const title = escapeHtml(c.bandNames.length ? c.bandNames.join(", ") : c.name || "Concert");
      const href = c.url ? safeHref(c.url) : null;
      const link = href ? `<a href="${escapeHtml(href)}">${title}</a>` : title;
      const where = [c.venue, c.city, c.country].filter(Boolean).map(escapeHtml).join(", ");
      return `<li><strong>${link}</strong> — ${fmtDate(c.date)} @ ${where}</li>`;
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
  const subject =
    items.length === 1
      ? `New concert: ${items[0].bandNames[0] || items[0].name}`
      : `${items.length} new concerts matching your subscriptions`;

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

module.exports = { sendDigestEmail, sendEmailVerificationCode, buildDigestHtml };
