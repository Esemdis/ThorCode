const express = require("express");
const router = express.Router();
const prisma = require("../../utils/prisma");
const axios = require("axios");

const rateLimit = require("express-rate-limit");
// Rate limiter: max 5 requests per 15 minutes per IP
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 requests per windowMs
  message: { error: "Too many registration attempts, please try again later." },
});
const auth = require("../../middleware/auth");

router.post("/me", auth, registerLimiter, async (req, res) => {
  try {
    const userId = req.user.id;

    const oauth = await prisma.oauth.findUnique({
      where: {
        userId_provider: {
          userId,
          provider: "tmdb",
        },
      },
      select: {
        providerUserId: true, // TMDb account ID
        accessToken: true, // TMDb session ID
      },
    });
    if (!oauth || !oauth.providerUserId || !oauth.accessToken) {
      return res.status(400).json({
        error: "You must link your TMDB account first.",
      });
    }
    let movies = [];

    try {
      // Fetch the user's rated movies from TMDb
      const { data } = await axios.get(
        `https://api.themoviedb.org/3/account/${oauth.providerUserId}/rated/movies`,
        {
          params: {
            api_key: process.env.TMDB_API_KEY,
            session_id: oauth.accessToken,
          },
        }
      );

      movies = data.results.map((movie) => ({
        name: movie.original_title,
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
      // Upsert Movie
      const dbMovie = await prisma.movie.upsert({
        where: { id: movie.id },
        update: { name: movie.name },
        create: {
          id: movie.id,
          name: movie.name,
        },
      });

      // Upsert MovieReviews for the user and movie
      await prisma.movieReviews.upsert({
        where: {
          userId_movieId: {
            userId,
            movieId: dbMovie.id,
          },
        },
        update: {
          rating: movie.rating,
        },
        create: {
          userId,
          movieId: dbMovie.id,
          rating: movie.rating,
        },
      });

      upsertedMovieIds.push(dbMovie.id);
    }

    // Optionally, remove reviews for movies not in the latest top list
    await prisma.movieReviews.deleteMany({
      where: {
        userId,
        movieId: { notIn: upsertedMovieIds },
      },
    });
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
