// Find specific user in the database

const supabase = require("./supabase");

async function findUserById({ userId }) {
  const { data: user, error } = await supabase
    .from("users")
    .select(
      `
      id,
      email,
      role,
      created_at,
      game_times (
        play_time,
        updated_at,
        game:game (
          id,
          name,
          appid
        )
      ),
      movie_reviews (
        id,
        rating,
        movie:movie (
          id,
          name
        )
      )
    `
    )
    .eq("id", userId)
    .single();

  if (error) throw error;
  console.log(user);
  // Limit to top 3 gameTimes and movieReviews in JS (Supabase doesn't support per-relation limit/order in one query)
  user.game_times = (user.game_times || [])
    .sort((a, b) => b.play_time - a.play_time)
    .slice(0, 3);

  user.movie_reviews = (user.movie_reviews || []).slice(0, 3);

  return user;
}
async function findUserByEmail({ email }) {
  const { data: user, error } = await supabase
    .from("users")
    .select(
      `
      id,
      email,
      role,
      created_at,
      password_hash
      `
    )
    .eq("email", email)
    .maybeSingle();

  if (error) throw error;

  return user;
}
module.exports = { findUserById, findUserByEmail };
