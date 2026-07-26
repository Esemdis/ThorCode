const { Resend } = require("resend");

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

function buildDigestHtml(items) {
  const rows = items
    .map((c) => {
      const title = c.bandNames.length ? c.bandNames.join(", ") : c.name || "Concert";
      const link = c.url ? `<a href="${c.url}">${title}</a>` : title;
      return `<li><strong>${link}</strong> — ${fmtDate(c.date)} @ ${c.venue}, ${c.city}, ${c.country}</li>`;
    })
    .join("");
  return `<p>New concerts matching your subscriptions:</p><ul>${rows}</ul>`;
}

async function sendDigestEmail({ to, items }) {
  const subject =
    items.length === 1
      ? `New concert: ${items[0].bandNames[0] || items[0].name}`
      : `${items.length} new concerts matching your subscriptions`;

  await getResend().emails.send({
    from: process.env.NOTIFICATIONS_FROM_EMAIL,
    to,
    subject,
    html: buildDigestHtml(items),
  });
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

module.exports = { sendDigestEmail, sendEmailVerificationCode };
