const express = require("express");
const router = express.Router();
const { validationResult, param } = require("express-validator");
const prisma = require("../../utils/prisma");
const axios = require("axios");

const auth = require("../../middleware/auth");
const roleCheck = require("../../middleware/roleCheck");
const STEAM_API_KEY = process.env.STEAM_API_KEY; // Set this in your .env
const { rateLimiter } = require("../../utils/rateLimiter");
// Defaults to 5 requests per 15 minutes per IP
const rateLimit = rateLimiter({
  message: "Too many requests to the Steam data route, please try again later.",
});

router.post(
  "/:id",
  rateLimit,
  auth,
  param("id").isInt().withMessage("Invalid Steam user ID format"),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      // Check for validation errors
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = req.user.id;
      const steamId = req.params.id;

      const existingUser = await prisma.user.findFirst({
        select: { id: true },
        where: { steamId: parseInt(steamId), id: { not: userId } },
      });

      if (existingUser) {
        return res
          .status(400)
          .json({ error: "Steam user already registered." });
      }

      const lastGameTime = await prisma.gameTime.findFirst({
        where: { userId },
        orderBy: { updated_at: "desc" },
      });

      if (
        lastGameTime &&
        new Date() - new Date(lastGameTime.updated_at) < 24 * 60 * 60 * 1000 && // 24 hours in milliseconds
        req.user.role !== "ADMIN" // Allow admins to bypass this check
      ) {
        return res
          .status(429)
          .json({ error: "You can only update your top games once per day." });
      }
      let topGames = [];
      try {
        const { data } = await axios.get(
          "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/",
          {
            params: {
              key: STEAM_API_KEY,
              steamid: steamId,
              include_appinfo: true,
              include_played_free_games: true,
            },
          }
        );

        if (!data.response?.games || data.response.games.length === 0) {
          return res.status(404).json({
            error: "No games found for this Steam user.",
          });
        }
        // Sort games by playtime_forever (descending) and take top 5
        topGames = data.response.games
          .sort((a, b) => b.playtime_forever - a.playtime_forever)
          .slice(0, 5);

        // Format the top games
        topGames.forEach((game) => {
          game.playtime_forever = Math.round(game.playtime_forever / 60); // Convert minutes to hours
          game.name = game.name || "Unknown Game"; // Fallback for missing names
        });
      } catch (error) {
        console.error("Error fetching users steam games:", error);
        if (error.status === 429) {
          return res.status(429).json({
            error: "Steam API rate limit exceeded. Please try again later.",
          });
        }

        return res.status(500).json({ error: "Internal server error" });
      }

      // Upsert Game and GameTime for each top game
      const upsertedGameIds = [];
      for (const game of topGames) {
        const dbGame = await prisma.game.upsert({
          where: { appid: game.appid },
          update: { name: game.name || "Unknown Game" },
          create: {
            appid: game.appid,
            name: game.name || "Unknown Game",
          },
        });

        // Upsert GameTime for the user and game
        await prisma.gameTime.upsert({
          where: {
            userId_gameId: {
              userId,
              gameId: dbGame.id,
            },
          },
          update: {
            updated_at: new Date(),
            play_time: game.playtime_forever,
          },
          create: {
            userId,
            gameId: dbGame.id,
            updated_at: new Date(),
            play_time: game.playtime_forever,
          },
        });

        upsertedGameIds.push(dbGame.id);
      }

      await prisma.gameTime.deleteMany({
        where: {
          userId,
          gameId: { notIn: upsertedGameIds },
        },
      });

      res.json({
        message: "Top games updated!",
        games: topGames.map((g) => ({
          appid: g.appid,
          name: g.name,
          hours: g.playtime_forever,
        })),
      });
    } catch (error) {
      console.error("Error fetching steam user games:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);
// List all games in the DB
router.get("/games", auth, roleCheck(["ADMIN"]), async (req, res) => {
  try {
    const games = await prisma.game.findMany({
      orderBy: { name: "asc" },
      select: {
        appid: true,
        name: true,
      },
    });

    res.json(games);
  } catch (error) {
    console.error("Error fetching games:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
module.exports = router;
