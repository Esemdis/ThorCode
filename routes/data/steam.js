const express = require("express");
const router = express.Router();
const { validationResult, param } = require("express-validator");
const supabase = require("../../utils/supabase");
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

      // Check if Steam user already registered
      const { data: existingUser, error: existingUserError } = await supabase
        .from("users")
        .select("id")
        .eq("steam_id", parseInt(steamId))
        .neq("id", userId)
        .maybeSingle();

      if (existingUser) {
        return res
          .status(400)
          .json({ error: "Steam user already registered." });
      }

      // Get last gameTime for user
      const { data: lastGameTime, error: lastGameTimeError } = await supabase
        .from("game_times")
        .select("updated_at")
        .eq("user", userId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (
        lastGameTime &&
        new Date() - new Date(lastGameTime.updated_at) < 24 * 60 * 60 * 1000 &&
        req.user.role !== "ADMIN"
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
        // Upsert Game
        const { data: dbGame } = await supabase
          .from("games")
          .upsert([{ appid: game.appid, name: game.name }], {
            onConflict: "appid",
          })
          .select()
          .single();

        // Upsert GameTime
        await supabase.from("game_times").upsert(
          [
            {
              user: userId,
              game: dbGame.id,
              updated_at: new Date().toISOString(),
              play_time: game.playtime_forever,
            },
          ],
          { onConflict: "user,game" }
        );

        upsertedGameIds.push(dbGame.id);
      }

      // Remove gameTimes not in top list
      await supabase
        .from("game_time")
        .delete()
        .match({ userId })
        .not("game", "in", `(${upsertedGameIds.join(",")})`);

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
    const { data: games, error } = await supabase
      .from("games")
      .select("appid, name")
      .order("name", { ascending: true });

    if (error) {
      throw error;
    }

    res.json(games);
  } catch (error) {
    console.error("Error fetching games:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
module.exports = router;
