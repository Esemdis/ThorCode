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
      gameTimes: {
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
      movieReviews: {
        select: {
          id: true,
          rating: true,
          movie: {
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
  // Limit to top 3 gameTimes and movieReviews in JS
  user.gameTimes = (user.gameTimes || [])
    .sort((a, b) => b.play_time - a.play_time)
    .slice(0, 3);

  user.movieReviews = (user.movieReviews || []).slice(0, 3);

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
