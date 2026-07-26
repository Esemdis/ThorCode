const express = require('express');
const router = express.Router();
const { validationResult, param } = require('express-validator');
const bcrypt = require('bcrypt');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const upload = multer();
const jwt = require('jsonwebtoken');

const userValidation = require('../utils/validation/user');
const auth = require('../auth/verifyJWT');
const roleCheck = require('../middlewares/roleCheck');
const { paginationValidation } = require('../utils/validation/pagination');
const { rateLimiter } = require('../utils/rateLimiter');
const prisma = require('../prisma/client');
const signJWT = require('../auth/signJWT');
const { sendEmailVerificationCode } = require('../utils/mail');

// Defaults to 5 requests per 15 minutes per IP
const rateLimit = rateLimiter({
  message: 'Too many requests to the users route, please try again later.',
});

router.post(
  '/register',
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
        return res.status(409).json({ error: 'Email already in use' });
      }

      // Hash the password
      const passwordHash = await bcrypt.hash(password, 10);

      const user = await prisma.user.create({
        data: {
          id: uuidv4().replace(/-/g, ''),
          email,
          password_hash: passwordHash,
        },
        select: { id: true, email: true },
      });

      await prisma.wishlist.create({
        data: { name: 'My Wishlist', user_id: user.id },
      });

      res.status(201).json({ message: 'User registered successfully', user });
    } catch (error) {
      console.error('Error during registration:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post(
  '/login',
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
        return res.status(403).json({ error: 'Invalid credentials' });
      }

      // Hash the password
      const passwordCompare = await bcrypt.compare(
        password,
        existingUser.password_hash,
      );

      if (!passwordCompare) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const user = {
        id: existingUser.id,
        email: existingUser.email,
        role: existingUser.role || 'USER', // Default to USER if no role is set
      };

      // If you want to be safer, you could insert the token into the DB
      // and check it on every request, but for simplicity, we will just sign it here and trust the expiry.
      const token = await signJWT({ user });

      // Return the user and token
      res
        .status(200)
        .json({ message: 'User logged in successfully', user, token });
    } catch (error) {
      console.error('Error during login:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.patch('/me/settings', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { settings } = req.body;
    if (settings === undefined || typeof settings !== 'object' || Array.isArray(settings)) {
      return res.status(400).json({ error: 'settings must be a JSON object' });
    }
    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { settings: true },
    });
    const merged = { ...(existing?.settings ?? {}), ...settings };
    const user = await prisma.user.update({
      where: { id: userId },
      data: { settings: merged },
      select: { id: true, settings: true },
    });
    res.json({ settings: user.settings });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        created_at: true,
        settings: true,
        game_times: {
          select: {
            play_time: true,
            updated_at: true,
            game_rel: {
              select: {
                id: true,
                name: true,
                appid: true,
              },
            },
          },
        },
        movie_reviews: {
          select: {
            id: true,
            rating: true,
            movie_rel: {
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
      return res.status(404).json({ error: 'User not found' });
    }

    // Limit to top 3 game_times and movie_reviews in JS
    user.game_times = (user.game_times || [])
      .sort((a, b) => b.play_time - a.play_time)
      .slice(0, 3);

    user.movie_reviews = (user.movie_reviews || []).slice(0, 3);

    res.json({ user });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get(
  '/',
  auth,
  roleCheck(['ADMIN']),
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
          orderBy: { created_at: 'desc' },
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
      console.error('Error fetching users:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

const cuidRegex = /^[a-z0-9]{32}$/;
router.get(
  '/:id',
  auth,
  roleCheck(['ADMIN']),
  param('id')
    .isString()
    .matches(cuidRegex)
    .withMessage('Invalid user ID format'),
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
          game_times: {
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
          movie_reviews: {
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
        return res.status(404).json({ error: 'User not found' });
      }

      // Limit to top 3 game_times and movie_reviews in JS
      user.game_times = (user.game_times || [])
        .sort((a, b) => b.play_time - a.play_time)
        .slice(0, 3);

      user.movie_reviews = (user.movie_reviews || []).slice(0, 3);

      res.json({ user });
    } catch (error) {
      console.error('Error fetching user:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post('/email/request-change', auth, upload.none(), async (req, res) => {
  try {
    const userId = req.user.id;
    const { newEmail } = req.body;

    if (!newEmail || typeof newEmail !== 'string') {
      return res.status(400).json({ error: 'New email is required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check if email is already in use
    const existingUser = await prisma.user.findUnique({
      where: { email: newEmail },
    });
    if (existingUser) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    // Generate a 6-digit verification code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Delete any existing pending verification for this user
    await prisma.emailVerification.deleteMany({
      where: { user_id: userId },
    });

    // Create new verification record
    await prisma.emailVerification.create({
      data: {
        user_id: userId,
        new_email: newEmail,
        code,
        expires_at: expiresAt,
      },
    });

    // Send verification code to the new email
    await sendEmailVerificationCode({ to: newEmail, code });

    res.status(200).json({ message: 'Verification code sent to new email' });
  } catch (error) {
    console.error('Error requesting email change:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/email/verify-code', auth, upload.none(), async (req, res) => {
  try {
    const userId = req.user.id;
    const { code } = req.body;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Verification code is required' });
    }

    // Find the verification record
    const verification = await prisma.emailVerification.findUnique({
      where: { code },
    });

    if (!verification) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    // Check if it belongs to the current user
    if (verification.user_id !== userId) {
      return res.status(403).json({ error: 'Verification code does not match your account' });
    }

    // Check if code has expired
    if (new Date() > verification.expires_at) {
      await prisma.emailVerification.delete({
        where: { id: verification.id },
      });
      return res.status(400).json({ error: 'Verification code has expired' });
    }

    // Update user email
    const user = await prisma.user.update({
      where: { id: userId },
      data: { email: verification.new_email },
      select: { id: true, email: true },
    });

    // Delete the verification record
    await prisma.emailVerification.delete({
      where: { id: verification.id },
    });

    res.status(200).json({ message: 'Email updated successfully', user });
  } catch (error) {
    console.error('Error verifying email code:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
