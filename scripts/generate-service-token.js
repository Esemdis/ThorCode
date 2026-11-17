// Generates a non-expiring JWT for a given user email.
//
// Usage:
//   node scripts/generate-service-token.js <email>           # python-crohn's BACKEND_TOKEN (a SYSTEM account)
//   node scripts/generate-service-token.js --wander <email>  # the token pasted into wander's Settings
//
// Without --wander the token is a full session for the account, for good: it
// has no expiry, and the only way to end one is to change JWT_SECRET, which
// ends every session. --wander mints a token that reaches only the calls wander
// makes (auth/tokenScopes.js, THO-972), and only for a USER account.

require('dotenv').config();
const jwt = require('jsonwebtoken');
const prisma = require('../prisma/client');
const { normaliseEmail } = require('../utils/validation/email');
const { serviceTokenClaims } = require('../auth/tokenScopes');

const USAGE = 'Usage: node scripts/generate-service-token.js [--wander] <email>';

async function main() {
  const args = process.argv.slice(2);
  const wander = args.includes('--wander');
  const rest = args.filter((a) => a !== '--wander');
  // Stored lowercased; see utils/validation/email.js.
  const email = rest.length === 1 && normaliseEmail(rest[0]);
  if (!email) {
    console.error(USAGE);
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, role: true } });
  if (!user) {
    console.error(`No user found with email: ${email}`);
    process.exit(1);
  }

  let claims;
  try {
    claims = serviceTokenClaims(user, { wander });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (!wander && user.role !== 'SYSTEM') {
    console.warn(
      `\nWarning: ${user.email} is ${user.role}, not SYSTEM. This token is a full session for that account and never expires.` +
      '\nFor wander, mint it with --wander instead.'
    );
  }

  // No expiresIn: python-crohn and wander hold these indefinitely.
  const token = jwt.sign(claims, process.env.JWT_SECRET);

  console.log('\nToken generated for:', user.email);
  if (wander) {
    console.log('\nPaste this into wander, Settings, ThorCode token:\n');
    console.log(token);
  } else {
    console.log("\nSet this as python-crohn's BACKEND_TOKEN:\n");
    console.log(`BACKEND_TOKEN=${token}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
