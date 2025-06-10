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
const supabase = require("../utils/supabase");
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
      const existingUser = await findUserByEmail({ email });
      if (existingUser) {
        return res.status(409).json({ error: "Email already in use" });
      }

      // Hash the password
      const passwordHash = await bcrypt.hash(password, 10);

      const { data: user, error: insertError } = await supabase
        .from("users")
        .insert([
          {
            id: uuidv4().replace(/-/g, ""),
            email,
            password_hash: passwordHash,
          },
        ])
        .select("id, email")
        .single();

      if (insertError) {
        console.error("Error inserting user:", insertError);
        return res.status(500).json({ error: "Error creating user" });
      }

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
      const existingUser = await findUserByEmail({ email });
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
        .status(201)
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
    const user = await findUserById({ userId });

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
      const from = (page - 1) * limit;
      const to = from + limit - 1;

      // Fetch users with pagination
      const {
        data: users,
        count,
        error,
      } = await supabase
        .from("users")
        .select("id, email, role, created_at", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, to);

      if (!users) {
        return res.status(404).json({ error: "No users found" });
      }

      if (error) {
        console.error("Error fetching users:", error);
        return res.status(500).json({ error: "Internal server error" });
      }
      console.log(users);
      const total = count;
      const totalPages = Math.ceil((users?.length ? users.length : 0) / limit);

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
      console.log("Fetching user with ID:", req.params.id);
      const user = await findUserById({ userId: req.params.id });

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
