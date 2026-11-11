/**
 * Making an account, now that nobody can make their own.
 *
 * POST /users/register used to make an account for anyone who found the
 * sign-up page of concert-map or travel-bag: no invite, and an address nobody
 * verified. It is closed for good, and `scripts/create-user.js` is how the
 * owner adds a person. A switch that reopened the route was built first and
 * dropped: while it was on, the route was as open to everyone as before, and
 * the container reads its environment once at start, so turning it off again
 * needed a second restart that was easy to forget.
 *
 * Everything the script decides is here, where it can be tested without a
 * database: what its arguments mean, whether a password passes, and the write.
 */
const bcrypt = require('bcrypt');
const crypto = require('node:crypto');
const { validateEmail, normaliseEmail } = require('./validation/email');

// Said to the person on a sign-up page, so it is a sentence for them.
const REGISTRATION_CLOSED_MESSAGE = 'Sign-up is closed. Ask the owner for an account.';

// SYSTEM is the sync service's machine user and signs in with a minted token
// (scripts/generate-service-token.js), never a password, so it is not offered.
const ACCOUNT_ROLES = ['USER', 'ADMIN'];

const UNIQUE_VIOLATION = 'P2002';

const USAGE = [
  'Usage: node scripts/create-user.js --email <address> [--role USER|ADMIN] [--password <password>]',
  '',
  'Without --password one is generated and printed once. A password typed on',
  'the command line stays in the shell history, so prefer the generated one.',
].join('\n');

/**
 * What is wrong with a password, as the login form will judge it.
 *
 * The same three rules as utils/validation/user.js, which every sign-in runs:
 * an account made here with a password that chain rejects could never sign in.
 * Length is counted in code points, as express-validator's isLength counts it.
 *
 * @param {unknown} password
 * @returns {string[]} Empty when the password is acceptable.
 */
function passwordProblems(password) {
  if (typeof password !== 'string') return ['Password is required'];
  const problems = [];
  const length = [...password].length;
  if (length < 8 || length > 100) problems.push('Password must be at least 8 characters, at most 100 characters');
  if (!/[A-Z]/.test(password)) problems.push('Password must contain at least one uppercase letter');
  if (!/[a-z]/.test(password)) problems.push('Password must contain at least one lowercase letter');
  return problems;
}

/**
 * A password to hand someone: 24 random characters, with an uppercase and a
 * lowercase letter put in front so it passes the rules whatever the rest is.
 * base64url, so it survives being pasted into a chat or read out.
 */
function generatePassword(randomBytes = crypto.randomBytes) {
  return `Aa${randomBytes(18).toString('base64url')}`;
}

/**
 * The script's arguments, checked.
 *
 * @param {string[]} argv - Everything after the script's name.
 * @returns {{ ok: true, email: string, password: string|null, role: string }
 *   | { ok: false, error: string }} `password` is null when one should be
 *   generated. `email` comes back normalised, as it is stored.
 */
function parseCreateUserArgs(argv) {
  const given = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!['--email', '--password', '--role'].includes(flag)) return { ok: false, error: `Unknown argument: ${flag}` };
    // A flag at the end with nothing after it, or followed by another flag.
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) return { ok: false, error: `${flag} needs a value` };
    given[flag.slice(2)] = argv[i + 1];
  }

  const email = normaliseEmail(given.email);
  if (!validateEmail(email)) return { ok: false, error: '--email must be a valid address' };

  // Uppercased so `--role admin` works; anything else is refused rather than
  // quietly made a USER.
  const role = (given.role ?? 'USER').toUpperCase();
  if (!ACCOUNT_ROLES.includes(role)) return { ok: false, error: `--role must be one of ${ACCOUNT_ROLES.join(', ')}` };

  if (given.password !== undefined) {
    const problems = passwordProblems(given.password);
    if (problems.length) return { ok: false, error: problems.join('. ') };
  }

  return { ok: true, email, password: given.password ?? null, role };
}

/**
 * Create the account and its wishlist.
 *
 * One write for both. Two writes left an account with no wishlist when the
 * second failed, and every concert route assumes there is one.
 *
 * @param {object} prisma
 * @param {{ email: string, password: string, role?: string }} account - `email`
 *   already normalised.
 * @returns {Promise<{ status: 'created', user: { id: string, email: string, role: string } }
 *   | { status: 'exists' }>}
 */
async function createAccount(prisma, { email, password, role = 'USER' }) {
  // In any capitalisation. Addresses are stored lowercased now, but the
  // migration that folded the old ones left alone any two accounts that differ
  // only by case, so an exact match is not enough to call an address free.
  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true },
  });
  if (existing) return { status: 'exists' };

  try {
    const user = await prisma.user.create({
      data: {
        id: crypto.randomUUID().replace(/-/g, ''),
        email,
        password_hash: await bcrypt.hash(password, 10),
        role,
        wishlists: { create: { name: 'My Wishlist' } },
      },
      select: { id: true, email: true, role: true },
    });
    return { status: 'created', user };
  } catch (error) {
    // Made by someone else since the check above.
    if (error.code === UNIQUE_VIOLATION) return { status: 'exists' };
    throw error;
  }
}

module.exports = {
  REGISTRATION_CLOSED_MESSAGE, ACCOUNT_ROLES, USAGE,
  passwordProblems, generatePassword, parseCreateUserArgs, createAccount,
};
