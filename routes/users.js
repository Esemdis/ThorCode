const express = require("express");
const router = express.Router();
const { validationResult, param } = require("express-validator");
const bcrypt = require("bcrypt");
const prisma = require("../utils/prisma");
const multer = require("multer");
const userValidation = require("../utils/validation/user");
const upload = multer();
const jwt = require("jsonwebtoken");
const auth = require("../middleware/auth");
const roleCheck = require("../middleware/roleCheck");
const { paginationValidation } = require("../utils/validation/pagination");
const findUser = require("../utils/findUser");
const { rateLimiter } = require("../utils/rateLimiter");
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
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        return res.status(409).json({ error: "Email already in use" });
      }

      // Hash the password
      const passwordHash = await bcrypt.hash(password, 10);

      const user = await prisma.user.create({
        data: {
          email,
          passwordHash,
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
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (!existingUser) {
        return res.status(403).json({ error: "Invalid credentials" });
      }

      // Hash the password
      const passwordCompare = await bcrypt.compare(
        password,
        existingUser.passwordHash
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
      const token = jwt.sign(
        {
          id: user.id,
          email: user.email,
          role: user.role,
        },
        process.env.JWT_SECRET,
        { expiresIn: "8h" }
      );

      // Return the user and token
      res
        .status(201)
        .json({ message: "User logged in successfully", user, token });
    } catch (error) {
      console.error("Error during login:");
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

router.get("/me", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await findUser({ userId });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

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

      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;

      // Fetch total count for frontend pagination
      const total = await prisma.user.count();

      const users = await prisma.user.findMany({
        select: { id: true, email: true, role: true, createdAt: true },
        skip,
        take: limit,
      });

      if (skip >= total) {
        return res.status(404).json({
          error: `No users found on that page. The last page possible with your current limit is ${Math.ceil(
            total / limit
          )}`,
        });
      }

      res.json({ users, page, totalPages: Math.ceil(total / limit), total });
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

const cuidRegex = /^c[a-z0-9]{24}$/;
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
      console.log("Fetching user with ID:", req.params.id);
      const user = await findUser({ userId: req.params.id });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ user });
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
