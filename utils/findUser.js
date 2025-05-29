// Find specific user in the database

const prisma = require("./prisma");

async function findUser({ userId }) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      created_at: true,
      gameTimes: {
        orderBy: { play_time: "desc" },
        take: 3,
        select: {
          play_time: true,
          updated_at: true,
          game: {
            select: {
              id: true,
              name: true,
              appid: true,
            },
          },
        },
      },
    },
  });
}
module.exports = findUser;
