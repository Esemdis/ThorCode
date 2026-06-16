// Generates a non-expiring JWT service token for a given user email.
// Usage: node scripts/generate-service-token.js <email>
// Copy the output into your rss-watcher .env as THORCODE_API_TOKEN=<token>

require('dotenv').config();
const jwt = require('jsonwebtoken');
const prisma = require('../prisma/client');

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node scripts/generate-service-token.js <email>');
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, role: true } });
  if (!user) {
    console.error(`No user found with email: ${email}`);
    process.exit(1);
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, service: 'rss-watcher' },
    process.env.JWT_SECRET
    // no expiresIn — token is valid indefinitely
  );

  console.log('\nService token generated for:', user.email);
  console.log('\nAdd this to your rss-watcher .env:\n');
  console.log(`THORCODE_API_TOKEN=${token}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
