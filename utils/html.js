/**
 * Text made safe to put inside HTML — an element's content or a quoted
 * attribute value.
 *
 * For the few places this API writes HTML itself: the digest email, and the
 * page an OAuth callback shows when there is no app to send the browser back to.
 */
const ENTITIES = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/**
 * A URL for an href, or null when it is not http(s). A scraped `javascript:`
 * link must not become a clickable one.
 */
function safeHref(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

module.exports = { escapeHtml, safeHref };
