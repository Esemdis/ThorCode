const express = require("express");
const router = express.Router();
const { validationResult, param } = require("express-validator");
const bcrypt = require("bcrypt");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const upload = multer();
const jwt = require("jsonwebtoken");

const userValidation = require("../utils/validation/user");
const auth = require("../auth/verifyJWT");
const roleCheck = require("../middlewares/roleCheck");
const { paginationValidation } = require("../utils/validation/pagination");
const { findUserById, findUserByEmail } = require("../utils/findUser");
const { rateLimiter } = require("../utils/rateLimiter");
const prisma = require("../prisma/client");
const signJWT = require("../auth/signJWT");

// Defaults to 5 requests per 15 minutes per IP
const rateLimit = rateLimiter({
  message: "Too many requests to the users route, please try again later.",
});

router.post(
  "/register",
  rateLimit,
  upload.none(),
  userValidation,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      // Check for validation errors
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { email, password } = req.body;

      // Check if user already exists
      const existingUser = await prisma.user.findUnique({
        where: { email },
      });
      if (existingUser) {
        return res.status(409).json({ error: "Email already in use" });
      }

      // Hash the password
      const passwordHash = await bcrypt.hash(password, 10);

      const user = await prisma.user.create({
        data: {
          id: uuidv4().replace(/-/g, ""),
          email,
          password_hash: passwordHash,
        },
        select: { id: true, email: true },
      });

      res.status(201).json({ message: "User registered successfully", user });
    } catch (error) {
      console.error("Error during registration:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

router.post(
  "/login",
  rateLimit,
  upload.none(),
  userValidation,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      // Check for validation errors
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { email, password } = req.body;

      // Check if user already exists
      const existingUser = await prisma.user.findUnique({
        where: { email },
      });
      if (!existingUser) {
        return res.status(403).json({ error: "Invalid credentials" });
      }

      // Hash the password
      const passwordCompare = await bcrypt.compare(
        password,
        existingUser.password_hash
      );

      if (!passwordCompare) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const user = {
        id: existingUser.id,
        email: existingUser.email,
        role: existingUser.role || "USER", // Default to USER if no role is set
      };

      // If you want to be safer, you could insert the token into the DB
      // and check it on every request, but for simplicity, we will just sign it here and trust the expiry.
      const token = await signJWT({ user });

      // Return the user and token
      res
        .status(200)
        .json({ message: "User logged in successfully", user, token });
    } catch (error) {
      console.error("Error during login:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

router.get("/me", auth, async (req, res) => {
  try {
    const userId = req.user.id;
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

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Limit to top 3 gameTimes and movieReviews in JS
    user.gameTimes = (user.gameTimes || [])
      .sort((a, b) => b.play_time - a.play_time)
      .slice(0, 3);

    user.movieReviews = (user.movieReviews || []).slice(0, 3);

    res.json({ user });
  } catch (error) {
    console.error("Error fetching user:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get(
  "/",
  auth,
  roleCheck(["ADMIN"]),
  paginationValidation,
  async (req, res) => {
    try {
      const errors = validationResult(req);

      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      // Fetch users with pagination
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;

      const [users, total] = await Promise.all([
        prisma.user.findMany({
          skip,
          take: limit,
          orderBy: { created_at: "desc" },
          select: { id: true, email: true, role: true, created_at: true },
        }),
        prisma.user.count(),
      ]);

      const totalPages = Math.ceil(total / limit);

      if (!users || users.length === 0) {
        return res.status(404).json({
          error: `No users found on that page. The last page possible with your current limit is ${totalPages}`,
        });
      }

      res.json({ users, page, totalPages, total });
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

const cuidRegex = /^[a-z0-9]{32}$/;
router.get(
  "/:id",
  auth,
  roleCheck(["ADMIN"]),
  param("id")
    .isString()
    .matches(cuidRegex)
    .withMessage("Invalid user ID format"),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      // Check for validation errors
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      // Fetch user by ID
      const user = await prisma.user.findUnique({
        where: { id: req.params.id },
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

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Limit to top 3 gameTimes and movieReviews in JS
      user.gameTimes = (user.gameTimes || [])
        .sort((a, b) => b.play_time - a.play_time)
        .slice(0, 3);

      user.movieReviews = (user.movieReviews || []).slice(0, 3);

      res.json({ user });
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
