const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabase");
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

    const { data: user, error } = await supabase
      .from("users")
      .select("provider_user_id, access_token")
      .eq("id", userId)
      .single();

    if (!user || !user.provider_user_id || !user.access_token) {
      return res.status(400).json({
        error: "You must link your TMDB account first.",
      });
    }
    res.json({
      message: "Top movies updated!",
      user,
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
