/**
 * Validate email format
 * @param {string} email - Email to validate
 * @returns {boolean} True if valid email format
 */
function validateEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * An address as it is stored and compared: trimmed and lowercased.
 *
 * Addresses used to be compared exactly, so an account registered from a
 * phone keyboard as "Chris@…" could not sign in as "chris@…", and the two
 * could be registered as separate accounts. Not express-validator's
 * normalizeEmail, which also strips the dots from a Gmail address — the
 * address mail is then sent to.
 *
 * @param {unknown} email
 * @returns {string}
 */
function normaliseEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

module.exports = { validateEmail, normaliseEmail };
