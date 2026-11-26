// Mints a long-lived JWT for a given user email.
//
// Usage:
//   node scripts/generate-service-token.js <email>           # python-crohn's BACKEND_TOKEN (a SYSTEM account)
//   node scripts/generate-service-token.js --wander <email>  # the token pasted into wander's Settings
//   node scripts/generate-service-token.js --days 90 <email> # any of the above, for 90 days instead of 365
//
// Without --wander the token is a full session for the account until it
// expires or is withdrawn. --wander mints a token that reaches only the calls
// wander makes (auth/tokenScopes.js, THO-972), and only for a USER account.
//
// Each token gets a ServiceToken row, written before the token is signed,
// whose id is the token's `jti` (THO-1016). `node scripts/service-tokens.js
// withdraw <jti>` ends that one token without touching JWT_SECRET or any other
// session; `list` shows them all.

require('dotenv').config();
const jwt = require('jsonwebtoken');
const prisma = require('../prisma/client');
const { serviceTokenClaims, parseMintArgs, serviceTokenExpiry } = require('../auth/tokenScopes');

const USAGE = 'Usage: node scripts/generate-service-token.js [--wander] [--days N] <email>';

async function main() {
  const args = parseMintArgs(process.argv.slice(2));
  if (args.error) {
    console.error(args.error);
    console.error(USAGE);
    process.exit(1);
  }
  const { wander, days, email } = args;

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, role: true } });
  if (!user) {
    console.error(`No user found with email: ${email}`);
    process.exit(1);
  }

  // The claims are checked with a stand-in id before any row is written, so a
  // refused mint (a wander token for an ADMIN) leaves nothing behind in the list.
  const expiresAt = serviceTokenExpiry(days);
  try {
    serviceTokenClaims(user, { wander, jti: 'pending', expiresAt });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (!wander && user.role !== 'SYSTEM') {
    console.warn(
      `\nWarning: ${user.email} is ${user.role}, not SYSTEM. This token is a full session for that account until it expires or is withdrawn.` +
      '\nFor wander, mint it with --wander instead.'
    );
  }

  // The row first: a token signed before its row existed would be refused,
  // and one whose row failed to write could never be withdrawn.
  const row = await prisma.serviceToken.create({
    data: { user_id: user.id, scope: wander ? 'wander' : null, expires_at: expiresAt },
    select: { id: true, expires_at: true },
  });
  const claims = serviceTokenClaims(user, { wander, jti: row.id, expiresAt: row.expires_at });
  // No expiresIn: `exp` is in the claims, equal to the row's expires_at.
  const token = jwt.sign(claims, process.env.JWT_SECRET, { algorithm: 'HS256' });

  console.log('\nToken generated for:', user.email);
  console.log(`id (jti): ${row.id}`);
  console.log(`expires:  ${row.expires_at.toISOString()} (${days} days)`);
  if (wander) {
    console.log('\nPaste this into wander, Settings, ThorCode token:\n');
    console.log(token);
  } else {
    console.log("\nSet this as python-crohn's BACKEND_TOKEN:\n");
    console.log(`BACKEND_TOKEN=${token}`);
  }
  console.log(`\nTo withdraw it: node scripts/service-tokens.js withdraw ${row.id}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
