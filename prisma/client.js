const { PrismaClient } = require("@prisma/client");

function buildDatasourceUrl() {
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("connection_limit", "30");
  url.searchParams.set("pool_timeout", "30");
  return url.toString();
}

const prisma = global.prisma || new PrismaClient({
  datasourceUrl: buildDatasourceUrl(),
});

if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}

module.exports = prisma;
