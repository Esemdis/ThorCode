const express = require('express');
const router = express.Router();
const { validationResult, param } = require('express-validator');
const bcrypt = require('bcrypt');
const multer = require('multer');
const crypto = require('node:crypto');
const { v4: uuidv4 } = require('uuid');
const upload = multer();

const userValidation = require('../utils/validation/user');
const auth = require('../auth/verifyJWT');
const roleCheck = require('../middlewares/roleCheck');
const { paginationValidation } = require('../utils/validation/pagination');
const { rateLimiter } = require('../utils/rateLimiter');
const prisma = require('../prisma/client');
const signJWT = require('../auth/signJWT');
const { sendEmailVerificationCode } = require('../utils/mail');
const { validateEmail } = require('../utils/validation/email');
const {
  emailRequestRateLimiter,
  emailVerificationRateLimiter,
} = require('../utils/emailRateLimiter');
const response = require('../utils/apiResponse');

// Wrong passwords, per IP: ten per quarter hour. Successful sign-ins do not
// count. Login and register used to share one limiter at rateLimiter's default
// of ten a minute — 14,400 guesses a day from one address — under a comment
// promising five per fifteen minutes.
const loginLimit = rateLimiter({
  message: 'Too many failed sign-ins. Please wait a few minutes and try again.',
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
});

// New accounts, per IP: a handful an hour is plenty for a household.
const registerLimit = rateLimiter({
  message: 'Too many accounts created from here. Please try again later.',
  windowMs: 60 * 60 * 1000,
  max: 5,
});

// The profile both /me and the admin lookup return. The admin route spelled
// its own, selecting `game` and `movie` — scalar id columns — with a nested
// select, which Prisma refuses, so it answered 500 to every request it got.
const PROFILE_SELECT = {
  id: true,
  email: true,
  role: true,
  created_at: true,
  game_times: {
    select: {
      play_time: true,
      updated_at: true,
      game_rel: { select: { id: true, name: true, appid: true } },
    },
  },
  movie_reviews: {
    select: {
      id: true,
      rating: true,
      movie_rel: { select: { id: true, name: true } },
    },
  },
};

// Top 3 game_times and movie_reviews, trimmed in JS.
function trimProfile(user) {
  user.game_times = (user.game_times || [])
    .sort((a, b) => b.play_time - a.play_time)
    .slice(0, 3);
  user.movie_reviews = (user.movie_reviews || []).slice(0, 3);
  return user;
}

const UNIQUE_VIOLATION = 'P2002';

// Compared against when the email is unknown, so an unknown address costs the
// same bcrypt round as a wrong password and the response time says nothing
// about which it was.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

router.post(
  '/register',
  registerLimit,
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

      // The account and its wishlist in one write. Two writes left an account
      // with no wishlist when the second failed — and every concert route
      // assumes there is one.
      let user;
      try {
        user = await prisma.user.create({
          data: {
            id: uuidv4().replace(/-/g, ''),
            email,
            password_hash: passwordHash,
            wishlists: { create: { name: 'My Wishlist' } },
          },
          select: { id: true, email: true },
        });
      } catch (error) {
        // Registered by a second request since the check above.
        if (error.code === UNIQUE_VIOLATION) return res.status(409).json({ error: 'Email already in use' });
        throw error;
      }

      res.status(201).json({ message: 'User registered successfully', user });
    } catch (error) {
      console.error('Error during registration:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post(
  '/login',
  loginLimit,
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

      const existingUser = await prisma.user.findUnique({
        where: { email },
      });

      // Always one bcrypt comparison, whether or not the account exists or has
      // a password at all: an unknown email used to answer at once, which told
      // anyone timing it which addresses have accounts, and a null hash threw
      // inside bcrypt as a 500.
      const passwordCompare = await bcrypt.compare(
        password,
        existingUser?.password_hash || DUMMY_HASH,
      );

      if (!existingUser?.password_hash || !passwordCompare) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const user = {
        id: existingUser.id,
        email: existingUser.email,
        role: existingUser.role || 'USER', // Default to USER if no role is set
      };

      // If you want to be safer, you could insert the token into the DB
      // and check it on every request, but for simplicity, we will just sign it here and trust the expiry.
      const token = signJWT({ user });

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
      select: { ...PROFILE_SELECT, settings: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: trimProfile(user) });
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
        select: PROFILE_SELECT,
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({ user: trimProfile(user) });
    } catch (error) {
      console.error('Error fetching user:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

/**
 * POST /users/email/request-change
 * Initiates email change by sending verification code to new email
 * @body {string} newEmail - New email address
 * @returns {object} { success: true, message: string }
 * @throws {400} Invalid email format or email already in use
 * @throws {401} Unauthorized
 * @throws {409} Email already in use or pending verification
 * @throws {500} Server error
 */
router.post('/email/request-change', auth, emailRequestRateLimiter, upload.none(), async (req, res) => {
  try {
    const userId = req.user.id;
    const { newEmail } = req.body;

    // Validate email input
    if (!newEmail || typeof newEmail !== 'string') {
      return response.badRequest(res, 'New email is required');
    }

    if (!validateEmail(newEmail)) {
      return response.badRequest(res, 'Invalid email format');
    }

    // Check if email is already in use by another user
    const existingUser = await prisma.user.findUnique({
      where: { email: newEmail },
    });
    if (existingUser) {
      return response.conflict(res, 'Email already in use');
    }

    // Check if email is already pending verification by any user
    const existingPending = await prisma.emailVerification.findFirst({
      where: { new_email: newEmail },
    });
    if (existingPending) {
      return response.conflict(res, 'Email is already pending verification');
    }

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Delete any existing pending verification for this user
    await prisma.emailVerification.deleteMany({
      where: { user_id: userId },
    });

    // A 6-digit code from a cryptographic source — Math.random is predictable
    // from its own output. `code` is unique across every user's pending
    // changes, so two accounts drawing the same six digits made the second
    // request a 500; a collision now just draws again.
    let verification;
    for (let attempt = 0; !verification; attempt++) {
      try {
        verification = await prisma.emailVerification.create({
          data: {
            user_id: userId,
            new_email: newEmail,
            code: String(crypto.randomInt(100000, 1000000)),
            expires_at: expiresAt,
          },
        });
      } catch (error) {
        if (error.code !== UNIQUE_VIOLATION || attempt >= 4) throw error;
      }
    }
    const { code } = verification;

    // Send verification code to the new email
    try {
      await sendEmailVerificationCode({ to: newEmail, code });
    } catch (emailError) {
      // Cleanup on email send failure
      await prisma.emailVerification.delete({
        where: { id: verification.id },
      });
      console.error('Email send failed, verification record deleted:', emailError);
      return response.serverError(res, 'Failed to send verification email');
    }

    return response.success(res, 200, {}, 'Verification code sent to new email');
  } catch (error) {
    console.error('Error requesting email change:', error);
    return response.serverError(res, 'Internal server error');
  }
});

/**
 * POST /users/email/verify-code
 * Verifies email change code and updates user email
 * @body {string} code - 6-digit verification code
 * @returns {object} { success: true, data: { user: { id, email } }, message: string }
 * @throws {400} Invalid or expired verification code — including one that is
 *   someone else's, which is answered exactly like a wrong guess
 * @throws {401} Unauthorized
 * @throws {409} The new address was taken since the code was sent
 * @throws {500} Server error
 */
router.post('/email/verify-code', auth, emailVerificationRateLimiter, upload.none(), async (req, res) => {
  try {
    const userId = req.user.id;
    const { code } = req.body;

    if (!code || typeof code !== 'string') {
      return response.badRequest(res, 'Verification code is required');
    }

    // Looked up within the caller's own pending change. Found globally and
    // then compared, a guess that hit someone else's code answered "does not
    // match your account" — telling the guesser that code was live.
    const verification = await prisma.emailVerification.findFirst({
      where: { code, user_id: userId },
    });

    if (!verification) {
      return response.badRequest(res, 'Invalid verification code');
    }

    // Check if code has expired
    if (new Date() > verification.expires_at) {
      await prisma.emailVerification.delete({
        where: { id: verification.id },
      });
      return response.badRequest(res, 'Verification code has expired');
    }

    // Update the email and spend the code together. The address was checked
    // when the code was sent, fifteen minutes ago at most; someone may have
    // registered with it since, and the unique key answering that was a 500.
    let user;
    try {
      [user] = await prisma.$transaction([
        prisma.user.update({
          where: { id: userId },
          data: { email: verification.new_email },
          select: { id: true, email: true },
        }),
        prisma.emailVerification.delete({ where: { id: verification.id } }),
      ]);
    } catch (error) {
      if (error.code === UNIQUE_VIOLATION) return response.conflict(res, 'Email already in use');
      throw error;
    }

    return response.success(res, 200, { user }, 'Email updated successfully');
  } catch (error) {
    console.error('Error verifying email code:', error);
    return response.serverError(res, 'Internal server error');
  }
});

module.exports = router;
