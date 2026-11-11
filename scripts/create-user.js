// Makes an account. Sign-up is closed (POST /users/register answers 403), so
// this is the only way one is made; see utils/accounts.js for why.
//
// Usage: node scripts/create-user.js --email <address> [--role USER|ADMIN] [--password <password>]
//
// It needs DATABASE_URL. In the running container that comes from Doppler:
//   docker exec -it <container> doppler run -- node scripts/create-user.js --email someone@example.com
// Locally it reads .env, like the other scripts here.

require('dotenv').config();
const {
  USAGE, parseCreateUserArgs, generatePassword, createAccount,
} = require('../utils/accounts');

async function main() {
  const args = parseCreateUserArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(`${args.error}\n\n${USAGE}`);
    return 1;
  }

  // Required only once the arguments are good, so a typo answers with the
  // usage text rather than with a complaint about the database URL.
  const prisma = require('../prisma/client');
  try {
    const password = args.password ?? generatePassword();
    const result = await createAccount(prisma, { email: args.email, password, role: args.role });
    if (result.status === 'exists') {
      console.error(`An account for ${args.email} already exists. Nothing was changed.`);
      return 1;
    }

    console.log(`Created ${result.user.role} account for ${result.user.email}`);
    // Printed only when it was generated here: this is the one time it exists
    // anywhere but as a hash.
    if (args.password === null) console.log(`Password: ${password}`);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => { console.error(error); process.exitCode = 1; });
