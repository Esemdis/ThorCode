const express = require("express");
const router = express.Router();
const supabase = require("../../utils/supabase");
const axios = require("axios");
const auth = require("../../auth/verifyJWT");
const { rateLimiter } = require("../../utils/rateLimiter");
// Defaults to 5 requests per 15 minutes per IP
const rateLimit = rateLimiter({
  message: "Too many requests to the TMDB data point, please try again later.",
});

router.post("/me", auth, rateLimit, async (req, res) => {
  try {
    const userId = req.user.id;

    // Fetch oauth row for TMDB
    const { data: oauth, error: oauthError } = await supabase
      .from("oauth")
      .select("provider_user_id, access_token")
      .eq("user", userId)
      .eq("provider", "tmdb")
      .single();

    if (
      oauthError ||
      !oauth ||
      !oauth.provider_user_id ||
      !oauth.access_token
    ) {
      return res.status(400).json({
        error: "You must link your TMDB account first.",
      });
    }
    let movies = [];

    try {
      // Fetch the user's rated movies from TMDb
      const { data } = await axios.get(
        `https://api.themoviedb.org/3/account/${oauth.provider_user_id}/rated/movies`,
        {
          params: {
            api_key: process.env.TMDB_API_KEY,
            session_id: oauth.access_token,
          },
        }
      );

      movies = data.results.map((movie) => ({
        name: movie.original_title,
        // Use the TMDb movie ID as the unique identifier
        rating: movie.rating,
        id: movie.id,
      }));

      if (!data.results || data.results.length === 0) {
        return res.status(404).json({
          error: "No rated movies found for this TMDb user.",
        });
      }
    } catch (error) {
      console.error("Error fetching users TMDB:", error);
      if (error.status === 429) {
        return res.status(429).json({
          error: "TMDB API rate limit exceeded. Please try again later.",
        });
      }

      return res.status(500).json({ error: "Internal server error" });
    }

    const upsertedMovieIds = [];
    for (const movie of movies) {
      try {
        console.log("Processing movie:", movie);
        // Upsert Movie
        const { data: dbMovie, error: movieError } = await supabase
          .from("movies")
          .upsert([{ tmdb_id: movie.id, name: movie.name }], {
            onConflict: "tmdb_id",
          })
          .select("id, name")
          .maybeSingle();
        console.log("DB Movie:", dbMovie, movieError);
        // Upsert MovieReviews for the user and movie
        await supabase.from("movie_reviews").upsert(
          [
            {
              user: userId,
              movie: dbMovie.id,
              rating: movie.rating,
            },
          ],
          { onConflict: "user,movie" }
        );
        console.log("Upserted movie:", dbMovie);
        upsertedMovieIds.push(movie.id);
      } catch (error) {
        console.error("Error processing movie:", movie, error);
        continue; // Skip this movie if there's an error
      }
    }

    // Optionally, remove reviews for movies not in the latest top list
    await supabase
      .from("movieReviews")
      .delete()
      .match({ user: userId })
      .not("movie", "in", `(${upsertedMovieIds.join(",")})`);

    res.json({
      message: "Top movies updated!",
      movies,
    });
  } catch (error) {
    console.error(
      "Error fetching TMDb reviewed movies:",
      error?.response?.data || error.message
    );
    res
      .status(500)
      .json({ error: "Failed to fetch reviewed movies from TMDb" });
  }
});

module.exports = router;
