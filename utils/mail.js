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

async function sendEmailVerificationCode({ to, code }) {
  const html = `
    <p>You requested to change your email address. Please use the following verification code to confirm your new email:</p>
    <p style="font-size: 24px; font-weight: bold; letter-spacing: 2px; margin: 20px 0;">${code}</p>
    <p>This code will expire in 15 minutes. If you did not request this change, please ignore this email.</p>
  `;

  await getResend().emails.send({
    from: process.env.NOTIFICATIONS_FROM_EMAIL,
    to,
    subject: "Verify your new email address",
    html,
  });
}

module.exports = { sendDigestEmail, sendEmailVerificationCode };
