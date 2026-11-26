// Lists and withdraws the tokens scripts/generate-service-token.js mints (THO-1016).
//
// Usage:
//   node scripts/service-tokens.js list            # tokens that still work
//   node scripts/service-tokens.js list --all      # withdrawn and expired ones too
//   node scripts/service-tokens.js withdraw <jti>  # end that one token
//
// Withdrawing ends one token and nothing else: JWT_SECRET, login sessions and
// the account's other tokens keep working. The running API caches each token's
// row for a minute (auth/serviceTokens.js), so a withdrawal takes effect within
// 60 s.

require('dotenv').config();
const prisma = require('../prisma/client');
const {
  SERVICE_TOKENS_USAGE,
  parseServiceTokensArgs,
  formatServiceTokenRows,
} = require('../utils/serviceTokenAdmin');

async function list(all) {
  const now = new Date();
  const rows = await prisma.serviceToken.findMany({
    where: all ? {} : { withdrawn_at: null, expires_at: { gt: now } },
    select: {
      id: true, scope: true, created_at: true, expires_at: true, withdrawn_at: true,
      user_rel: { select: { email: true, role: true } },
    },
    orderBy: { created_at: 'asc' },
  });
  for (const line of formatServiceTokenRows(rows, now, { withStatus: all })) console.log(line);
}

async function withdraw(jti) {
  // Only a token not already withdrawn, so a second withdraw keeps the first
  // time rather than moving it.
  const { count } = await prisma.serviceToken.updateMany({
    where: { id: jti, withdrawn_at: null },
    data: { withdrawn_at: new Date() },
  });
  if (count === 1) {
    console.log(`Withdrawn ${jti}. It takes effect within 60 s.`);
    return;
  }
  const row = await prisma.serviceToken.findUnique({ where: { id: jti }, select: { withdrawn_at: true } });
  if (!row) {
    console.error(`No service token with id ${jti}`);
    process.exit(1);
  }
  console.log(`${jti} was already withdrawn at ${row.withdrawn_at.toISOString()}.`);
}

async function main() {
  const args = parseServiceTokensArgs(process.argv.slice(2));
  if (args.error) {
    console.error(args.error);
    console.error(SERVICE_TOKENS_USAGE);
    process.exit(1);
  }
  if (args.command === 'list') await list(args.all);
  else await withdraw(args.jti);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
