// The secret in a media share link.
//
// A recipient opening this link has no account and sends no Authorization
// header, so — like the calendar feed token — the URL itself is the
// credential. Unlike the calendar token, it also carries a fixed lifetime:
// the whole point is that it stops working on its own after 12 hours, not
// just when someone remembers to revoke it.

const crypto = require('crypto');

// 24 random bytes, base64url-encoded: the same entropy as the calendar feed
// token, for the same reason — this is a credential, not an identifier.
const TOKEN_BYTES = 24;

const TTL_MS = 12 * 60 * 60 * 1000; // fixed, not user-configurable
const SHARE_PATH = '/data/concerts/media/share';

function generateShareToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function shareExpiry(now = new Date()) {
  return new Date(now.getTime() + TTL_MS);
}

/**
 * The absolute URL a share link points to.
 *
 * Built from the configured public base URL and never from the incoming
 * request, for the same reason mediaTokens.js's mediaUrls() is: behind a
 * proxy the request host is whatever the proxy passes along, and the
 * frontend is on a different origin entirely. Validated the same way
 * mediaUrls() validates it too, since this is a sibling of that URL family
 * and a malformed CALLBACK_URL should fail loudly rather than hand out a
 * link that quietly resolves nowhere.
 */
function shareUrl(baseUrl, token) {
  if (!baseUrl) throw new Error('No public base URL configured (CALLBACK_URL)');
  const base = String(baseUrl).replace(/\/+$/, '');

  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`Public base URL (CALLBACK_URL) is not absolute: ${base}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Public base URL (CALLBACK_URL) is not http or https: ${base}`);
  }

  return `${base}${SHARE_PATH}/${token}`;
}

function isActiveShareLink(link, now = new Date()) {
  return Boolean(link) && !link.revoked_at && link.expires_at > now;
}

module.exports = { generateShareToken, shareExpiry, shareUrl, isActiveShareLink, TTL_MS };
