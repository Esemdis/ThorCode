// Find specific user in the database

const prisma = require("../prisma/client");

async function findUserById({ userId }) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      created_at: true,
      game_times: {
        select: {
          play_time: true,
          updated_at: true,
          game_rel: {
            select: {
              id: true,
              name: true,
              appid: true,
            },
          },
        },
      },
      movie_reviews: {
        select: {
          id: true,
          rating: true,
          movie_rel: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  });

  if (!user) throw new Error("User not found");
  // Limit to top 3 game_times and movie_reviews in JS
  user.game_times = (user.game_times || [])
    .sort((a, b) => b.play_time - a.play_time)
    .slice(0, 3);

  user.movie_reviews = (user.movie_reviews || []).slice(0, 3);

  return user;
}

async function findUserByEmail({ email }) {
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      role: true,
      created_at: true,
      password_hash: true,
    },
  });

  return user;
}
module.exports = { findUserById, findUserByEmail };
