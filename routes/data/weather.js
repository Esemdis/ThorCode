const express = require("express");
const router = express.Router();
const { validationResult, param } = require("express-validator");
const axios = require("axios");

const auth = require("../../middleware/auth");
const roleCheck = require("../../middleware/roleCheck");
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const IPSTACK_API_KEY = process.env.IPSTACK_API_KEY;
const { rateLimiter } = require("../../utils/rateLimiter");
const weatherURL = "http://api.weatherapi.com/v1/";
// Defaults to 5 requests per 15 minutes per IP

const rateLimit = rateLimiter({
  message: "Too many requests to the Steam data route, please try again later.",
});

router.patch(
  "/weather/user/me",
  rateLimit,
  auth,
  param("id").isInt().withMessage("Invalid user ID format"),
  async (req, res) => {
    try {
      // 1. Get user's IP address
      const ip =
        req.headers["x-forwarded-for"]?.split(",")[0] ||
        req.connection.remoteAddress;

      // 2. Get location from IP
      const geoRes = await axios.get(
        `http://api.ipstack.com/${ip}?access_key=${IPSTACK_API_KEY}`
      );
      const { city, country_name } = geoRes.data;

      if (!city) {
        return res
          .status(400)
          .json({ error: "Could not determine city from IP." });
      }

      // 3. Get weather forecast for city using weatherapi.com
      const weatherRes = await axios.get(
        `http://api.weatherapi.com/v1/forecast.json`,
        {
          params: {
            key: WEATHER_API_KEY,
            q: city,
            days: 3, // Number of days for forecast
          },
        }
      );

      res.json({
        location: { city, country: country_name },
        forecast: weatherRes.data.forecast,
        current: weatherRes.data.current,
      });
    } catch (error) {
      console.error(
        "Error fetching weather forecast:",
        error?.response?.data || error.message
      );
      res.status(500).json({ error: "Failed to fetch weather forecast." });
    }
  }
);
const supabase = require("../../utils/supabase");
// List all games in the DB
router.get("/games", auth, roleCheck(["ADMIN"]), async (req, res) => {
  try {
    const { data: games, error } = await supabase
      .from("game")
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
