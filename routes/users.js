const express = require('express');
const router = express.Router();
const { validationResult, param } = require('express-validator');
const bcrypt = require('bcrypt');
const multer = require('multer');
const crypto = require('node:crypto');
const upload = multer();

const userValidation = require('../utils/validation/user');
const { passwordValidation, passwordRulesFor } = require('../utils/validation/user');
const auth = require('../auth/verifyJWT');
const roleCheck = require('../middlewares/roleCheck');
const { paginationValidation } = require('../utils/validation/pagination');
const { rateLimiter } = require('../utils/rateLimiter');
const prisma = require('../prisma/client');
const signJWT = require('../auth/signJWT');
const { forgetPasswordChange, isLoginToken, passwordChangeStamp } = require('../auth/loginRevocation');
const { sendEmailVerificationCode } = require('../utils/mail');
// Reached through the module object, not destructured, so a test can replace
// one sender with vi.spyOn and the route sees the replacement.
const mail = require('../utils/mail');
const {
  RESET_TTL_MS,
  newResetToken,
  hashResetToken,
  resetLink,
  isPlausibleToken,
} = require('../utils/passwordReset');
const { validateEmail, normaliseEmail } = require('../utils/validation/email');
const {
  emailRequestRateLimiter,
  emailVerificationRateLimiter,
} = require('../utils/emailRateLimiter');
const response = require('../utils/apiResponse');
const {
  accountDeletionRefusal,
  accountDeletionOperations,
  removeAccountMedia,
  removeDerivedCopies,
} = require('../utils/accountDeletion');
const { REGISTRATION_CLOSED_MESSAGE } = require('../utils/accounts');

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

// The profile both /me and the admin lookup return.
const PROFILE_SELECT = {
  id: true,
  email: true,
  role: true,
  created_at: true,
};

const UNIQUE_VIOLATION = 'P2002';

// Any account whose address differs from this one only by case. Addresses are
// stored lowercased now, but the migration that folded the old ones left alone
// any two accounts that differ only by case, rather than fail on the unique key.
//
// Prisma's insensitive `equals` is an ILIKE on Postgres, and it passes the
// value through unescaped: a `%` or `_` in an address was a wildcard, so
// `vic%@…` and `v_ctim@…` found victim@… (checked against Postgres 16). That
// let the forgot form mail one person's reset link from a fresh per-address
// bucket per variant, and let /register answer 409 to a prefix. Escaped here,
// with LIKE's default escape character, so only case is ignored.
const escapeLike = (value) => value.replace(/[\\%_]/g, (c) => `\\${c}`);
const sameAddress = (email) => ({ email: { equals: escapeLike(email), mode: 'insensitive' } });

/**
 * The account an address signs in to, however it was capitalised. An exact
 * match wins; otherwise one account differing only by case, and never a guess
 * between two.
 *
 * @param {string} email - already normalised
 */
async function findUserByEmail(email) {
  const candidates = await prisma.user.findMany({ where: sameAddress(email), take: 2 });
  return candidates.find((u) => u.email === email) ?? (candidates.length === 1 ? candidates[0] : null);
}

// Compared against when the email is unknown, so an unknown address costs the
// same bcrypt round as a wrong password and the response time says nothing
// about which it was.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

// Closed for good. This made an account for anyone who found a sign-up page;
// accounts are now made by the owner with scripts/create-user.js (see
// utils/accounts.js). The route stays, answering every request the same way,
// so the sign-up pages still out there show a sentence instead of a 404, and
// so the answer says nothing about which addresses have an account.
router.post('/register', (req, res) => {
  res.status(403).json({ error: REGISTRATION_CLOSED_MESSAGE });
});

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

      const existingUser = await findUserByEmail(email);

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

      // Signed against the row whose hash was just checked: if a reset
      // committed in between, this token is already ended (THO-898).
      const token = signJWT({ user, passwordChangedAt: existingUser.password_changed_at });

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
        select: PROFILE_SELECT,
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({ user });
    } catch (error) {
      console.error('Error fetching user:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// --- Proving the current password (THO-810, THO-898) ----------------------

// A write that changes the password state (a change, an email change) reads
// the row, works for a while (three bcrypt rounds, about 200 ms, on a
// change) and then writes. Written `where: { id }`, one still in flight from
// a session a reset had just ended overwrote the reset and came back with a
// fresh token that passed every check (THO-898 review). So the write is
// conditional on the state it read (`update` with `password_changed_at` in
// its where throws P2025 when that moved), and a login token must still
// carry that state when the work starts.
const SESSION_ENDED = 'Your password was changed. Sign in again.';
const STATE_MOVED = 'Your password was changed while this was being saved. Try again.';
const CODE_GONE = 'That code is no longer valid. Ask for a new one.';

/** Whether a login token was signed against a password state other than this one. */
const sessionPredates = (req, passwordChangedAt) => isLoginToken(req.user)
  && req.user.pwc !== passwordChangeStamp(passwordChangedAt);

/**
 * The answer when the state a request read moved before it wrote: the
 * session is over for a login token (and concert-map signs out on that 401,
 * which is right); anything else may simply try again.
 */
const stateMovedAnswer = (req, res) => (isLoginToken(req.user)
  ? response.unauthorized(res, SESSION_ENDED)
  : response.conflict(res, STATE_MOVED));

const WRONG_CURRENT_PASSWORD = 'Your current password is not right';
const NO_CURRENT_PASSWORD =
  'This account has no password yet. Sign out and use "Forgot password?" to set one first.';

// Wrong current passwords, per account, shared by every route that asks for
// one: a stolen session must not get a separate budget of guesses from each. Per account
// rather than per IP, because the guesser already holds that account's token
// and can ask from anywhere.
const currentPasswordLimit = rateLimiter({
  message: 'Too many wrong passwords. Please wait a few minutes and try again.',
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `user:${req.user.id}`,
  skipSuccessfulRequests: true,
  // Only a wrong (or missing-on-the-account) current password is a guess, and
  // both answer 403. Counting every 400 and 500 as one, someone retrying a
  // stuck deletion, or a new password the rules refuse, was told "Too many
  // wrong passwords" after giving the right one every time.
  requestWasSuccessful: (req, res) => res.statusCode !== 403,
});

/**
 * Why `given` does not prove the caller knows this account's password, or
 * null when it does.
 *
 * Answered with 403, never 401: concert-map signs the user out on any 401,
 * and a typo in a settings form must not end the session it was typed in.
 */
async function currentPasswordRefusal(user, given) {
  if (!user.password_hash) return NO_CURRENT_PASSWORD;
  return (await bcrypt.compare(given, user.password_hash)) ? null : WRONG_CURRENT_PASSWORD;
}

const readCurrentPassword = (req) => {
  const value = req.body?.currentPassword;
  return typeof value === 'string' && value ? value : null;
};

/**
 * POST /users/email/request-change
 * Initiates email change by sending verification code to new email
 * @body {string} newEmail - New email address
 * @body {string} currentPassword - THO-898: a session alone is not enough
 * @returns {object} { success: true, message: string }
 * @throws {400} Invalid email format, or no current password
 * @throws {401} Unauthorized
 * @throws {403} The current password is wrong, or the account has none
 * @throws {409} Email already in use or pending verification
 * @throws {429} Too many requests, or too many wrong passwords for this account
 * @throws {500} Server error
 */
// The wrong-password limiter after the request limiter, so a guess still
// spends one of the three requests a quarter hour.
router.post('/email/request-change', auth, emailRequestRateLimiter, currentPasswordLimit, upload.none(), async (req, res) => {
  try {
    const userId = req.user.id;
    // Validate email input
    if (!req.body.newEmail || typeof req.body.newEmail !== 'string') {
      return response.badRequest(res, 'New email is required');
    }

    // THO-898. With only a session, a stolen login token could move the
    // account to the thief's address, and the reset mail that would have
    // ended the thief's session then went to the thief. Checked before the
    // address is looked at, so a session alone cannot ask which addresses
    // have accounts either.
    const currentPassword = readCurrentPassword(req);
    if (!currentPassword) return response.badRequest(res, 'Current password is required');
    const account = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password_hash: true },
    });
    if (!account) return response.notFound(res, 'User not found');
    const wrong = await currentPasswordRefusal(account, currentPassword);
    if (wrong) return response.forbidden(res, wrong);
    // Stored and compared as sign-in compares it. See normaliseEmail.
    const newEmail = normaliseEmail(req.body.newEmail);

    if (!validateEmail(newEmail)) {
      return response.badRequest(res, 'Invalid email format');
    }

    // Check if email is already in use by another user, in any case
    const existingUser = await prisma.user.findFirst({
      where: sameAddress(newEmail),
      select: { id: true },
    });
    if (existingUser) {
      return response.conflict(res, 'Email already in use');
    }

    // Pending for someone else, and not yet expired. The caller's own request
    // is replaced below, which is how asking again for the same address works;
    // counted here, it refused exactly that. An expired one is nobody's claim
    // any more, though the hourly sweep may not have removed it yet.
    const existingPending = await prisma.emailVerification.findFirst({
      where: { new_email: newEmail, user_id: { not: userId }, expires_at: { gt: new Date() } },
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
 * Verifies email change code and updates user email.
 * Ends every login session the account had, this one included, and hands back
 * a fresh token for the caller to carry on with, as a password change does
 * (THO-898).
 * @body {string} code - 6-digit verification code
 * @returns {object} { success: true, data: { user: { id, email }, token }, message: string }
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
    //
    // It also counts as a password change (owner decision on THO-898): an
    // address change is how an account is taken over, so it ends the other
    // login sessions the same way.
    const current = await prisma.user.findUnique({ where: { id: userId }, select: { password_changed_at: true } });
    if (!current) return response.notFound(res, 'User not found');
    const readChangedAt = current.password_changed_at ?? null;
    if (sessionPredates(req, readChangedAt)) return response.unauthorized(res, SESSION_ENDED);

    const changedAt = new Date();
    let updated;
    try {
      [updated] = await prisma.$transaction([
        prisma.user.update({
          where: { id: userId, password_changed_at: readChangedAt },
          data: { email: verification.new_email, password_changed_at: changedAt },
          select: { id: true, email: true, role: true },
        }),
        prisma.emailVerification.delete({ where: { id: verification.id } }),
      ]);
    } catch (error) {
      if (error.code === UNIQUE_VIOLATION) return response.conflict(res, 'Email already in use');
      if (error.code === RECORD_NOT_FOUND) {
        // Either write can find nothing: the user row, when a reset moved the
        // state it read, or the code, when a second request-change (another
        // tab) replaced it. Only the first ends the session; read again to
        // tell them apart, rather than sign someone out over a stale code.
        const now = await prisma.user.findUnique({ where: { id: userId }, select: { password_changed_at: true } });
        if (now && passwordChangeStamp(now.password_changed_at) === passwordChangeStamp(readChangedAt)) {
          return response.conflict(res, CODE_GONE);
        }
        return stateMovedAnswer(req, res);
      }
      throw error;
    }
    forgetPasswordChange(userId);

    // Signed after the change, so the caller's own session survives it.
    const token = signJWT({
      user: { id: updated.id, email: updated.email, role: updated.role },
      passwordChangedAt: changedAt,
    });
    const user = { id: updated.id, email: updated.email };
    return response.success(res, 200, { user, token }, 'Email updated successfully');
  } catch (error) {
    console.error('Error verifying email code:', error);
    return response.serverError(res, 'Internal server error');
  }
});

// --- Forgotten password (THO-808) -------------------------------------------

const FORGOT_SENT = "If an account uses that address, we've sent a link to reset its password.";
const RESET_USED = 'This reset link has already been used or is not valid. Ask for a new one.';
const RESET_EXPIRED = 'This reset link has expired. Ask for a new one.';
const RECORD_NOT_FOUND = 'P2025';

// A limited "forgot" request is answered exactly like one that sent mail. A
// 429 only for addresses someone has been asking about, or a RateLimit header
// counting down, would tell a stranger which requests reached an account.
const answerForgotSent = (req, res) => response.success(res, 200, {}, FORGOT_SENT);

// Per IP: a person who forgot a password asks once or twice.
const forgotIpLimit = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 3,
  handler: answerForgotSent,
  standardHeaders: false,
});

// What the handler accepts as an address, shared with the limiter below.
const isForgotAddress = (value) => typeof value === 'string' && validateEmail(normaliseEmail(value));

// Per address, whichever IPs ask: without it, rotating IPs could fill one
// person's inbox with reset mail. Something that is not an address is left to
// the handler's 400: a blank or missing one normalised to '', so every such
// request from every IP shared one bucket, and after three of them everyone
// got the quiet 200 instead. Skipping turns on the shape of what was typed,
// never on whether an account uses it, so it says nothing about accounts.
const forgotAddressLimit = rateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => `addr:${normaliseEmail(req.body?.email)}`,
  skip: (req) => !isForgotAddress(req.body?.email),
  handler: answerForgotSent,
  standardHeaders: false,
});

// Guesses at a token, per IP. A token is 256 random bits, so this is about
// load rather than odds, at the email-change guess limit.
const resetLimit = rateLimiter({
  message: 'Too many attempts. Please wait a few minutes and try again.',
  windowMs: 15 * 60 * 1000,
  max: 8,
});

/**
 * Look the address up, store a fresh token's hash and mail the link.
 *
 * Runs after the request has been answered. Awaited, the answer for a known
 * address would wait on the database write and on Resend, and its timing alone
 * would say which addresses have accounts. Every failure is logged here and
 * nothing reaches the person asking.
 *
 * @param {string} email - already normalised
 */
async function issuePasswordReset(email) {
  const user = await findUserByEmail(email);
  if (!user) return;

  const token = newResetToken();
  const link = resetLink(process.env.CONCERT_MAP_URL, token);
  if (!link) {
    console.error('[password reset] CONCERT_MAP_URL is not set; no reset link was sent.');
    return;
  }

  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  // `user_id` is unique, so asking again replaces the live link rather than
  // adding another; the link in the earlier email stops working.
  await prisma.passwordReset.upsert({
    where: { user_id: user.id },
    create: { user_id: user.id, token_hash: tokenHash, expires_at: expiresAt },
    update: { token_hash: tokenHash, expires_at: expiresAt, created_at: new Date() },
  });

  try {
    // To the address on the account, which may differ by case from the one typed.
    await mail.sendPasswordResetEmail({ to: user.email, link });
  } catch (error) {
    // A link nobody received is spent. By hash, not by user: a second request
    // may already have replaced it, and that one did reach the inbox.
    await prisma.passwordReset.deleteMany({ where: { token_hash: tokenHash } });
    throw error;
  }
}

/**
 * POST /users/password/forgot
 * Mails a reset link to the account using `email`, if there is one.
 * @body {string} email
 * @returns {200} The same body whether or not the address has an account,
 *   whether or not the request was limited, and whether or not the mail went.
 * @throws {400} Not an email address
 */
router.post('/password/forgot', forgotIpLimit, upload.none(), forgotAddressLimit, (req, res) => {
  if (!isForgotAddress(req.body?.email)) {
    return response.badRequest(res, 'Valid email required');
  }
  const email = normaliseEmail(req.body.email);

  response.success(res, 200, {}, FORGOT_SENT);

  issuePasswordReset(email).catch((error) => {
    console.error('[password reset] Could not issue a reset link:', error);
  });
});

/**
 * POST /users/password/reset
 * Sets a new password with the token from a reset email, and spends the token.
 * Signs no one in, and ends every login session the account had (THO-898).
 * Service and other long-lived tokens keep working: auth/loginRevocation.js.
 * @body {string} token
 * @body {string} password - register's rules
 * @returns {200} "Password changed"
 * @throws {400} Used, unknown or expired token, or a password the rules refuse
 * @throws {429} Too many attempts from this IP
 */
router.post('/password/reset', resetLimit, upload.none(), passwordValidation, async (req, res) => {
  try {
    const { token, password } = req.body ?? {};
    if (!isPlausibleToken(token)) return response.badRequest(res, RESET_USED);

    const tokenHash = hashResetToken(token);
    const reset = await prisma.passwordReset.findUnique({ where: { token_hash: tokenHash } });
    if (!reset) return response.badRequest(res, RESET_USED);

    // The hourly sweep may not have reached it yet.
    if (reset.expires_at <= new Date()) {
      await prisma.passwordReset.deleteMany({ where: { token_hash: tokenHash } });
      return response.badRequest(res, RESET_EXPIRED);
    }

    // After the token, so a dead link says so before the rules are argued over.
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // The token goes with the change, in one transaction. Deleted by its hash:
    // when a second submit of the same link, or a newer link, got there first,
    // the delete finds nothing, the whole thing rolls back, and the answer is
    // "used" rather than a second password change. An account that never had
    // a password (`password_hash` null) gets one here.
    try {
      await prisma.$transaction([
        prisma.passwordReset.delete({ where: { token_hash: tokenHash } }),
        prisma.user.update({
          where: { id: reset.user_id },
          // Any new value ends the account's login tokens (THO-898).
          data: { password_hash: passwordHash, password_changed_at: new Date() },
        }),
      ]);
    } catch (error) {
      if (error.code === RECORD_NOT_FOUND) return response.badRequest(res, RESET_USED);
      throw error;
    }
    forgetPasswordChange(reset.user_id);

    return response.success(res, 200, {}, 'Password changed');
  } catch (error) {
    console.error('Error resetting password:', error);
    return response.serverError(res, 'Internal server error');
  }
});

// --- Signed in: change the password, delete the account (THO-810) -----------

/**
 * PATCH /users/me/password
 * Changes the caller's password, given the current one.
 * Ends every login session the account had, this one included, and hands back
 * a fresh token for the caller to carry on with (THO-898). Service and other
 * long-lived tokens keep working: auth/loginRevocation.js.
 * @body {string} currentPassword
 * @body {string} newPassword - register's rules
 * @returns {200} "Password changed", with `data.token`, a new login token
 * @throws {400} A missing current password, a new one the rules refuse, or the same one again
 * @throws {403} The current password is wrong, or the account has none
 * @throws {429} Too many wrong passwords for this account
 */
router.patch(
  '/me/password',
  auth,
  currentPasswordLimit,
  upload.none(),
  passwordRulesFor('newPassword'),
  async (req, res) => {
    try {
      const currentPassword = readCurrentPassword(req);
      if (!currentPassword) return response.badRequest(res, 'Current password is required');
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { newPassword } = req.body;

      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { id: true, email: true, role: true, password_hash: true, password_changed_at: true },
      });
      if (!user) return response.notFound(res, 'User not found');
      const readChangedAt = user.password_changed_at ?? null;
      if (sessionPredates(req, readChangedAt)) return response.unauthorized(res, SESSION_ENDED);

      const refusal = await currentPasswordRefusal(user, currentPassword);
      if (refusal) return response.forbidden(res, refusal);
      // Someone rotating a leaked password who types the old one again would
      // otherwise be told it changed when nothing did.
      if (await bcrypt.compare(newPassword, user.password_hash)) {
        return response.badRequest(res, 'Choose a password different from your current one');
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      const changedAt = new Date();
      // A reset link mailed before the change would undo it if used later, so
      // it goes with it.
      try {
        await prisma.$transaction([
          prisma.user.update({
            where: { id: user.id, password_changed_at: readChangedAt },
            data: { password_hash: passwordHash, password_changed_at: changedAt },
          }),
          prisma.passwordReset.deleteMany({ where: { user_id: user.id } }),
        ]);
      } catch (error) {
        if (error.code === RECORD_NOT_FOUND) return stateMovedAnswer(req, res);
        throw error;
      }
      forgetPasswordChange(user.id);

      // Signed after the change, so it is the one session that outlives it.
      // Without it the caller's own token, issued before the change, would be
      // refused on their next request and the settings form would sign out
      // the person who just used it.
      const token = signJWT({
        user: { id: user.id, email: user.email, role: user.role },
        passwordChangedAt: changedAt,
      });
      return response.success(res, 200, { token }, 'Password changed');
    } catch (error) {
      console.error('Error changing password:', error);
      return response.serverError(res, 'Internal server error');
    }
  },
);

/**
 * DELETE /users/me
 * Deletes the caller's account and everything it owns: concerts (wishlist,
 * attendance, follows, subscriptions, reviews, share links), the photos and
 * videos in the archive, music-service grants, and all Travel Bag data. See
 * utils/accountDeletion.js for the order and why.
 * @body {string} currentPassword
 * @returns {200} "Account deleted"; the address is free again at once
 * @throws {400} No current password
 * @throws {403} The current password is wrong, the account has none, or it is the service account
 * @throws {409} The last admin
 * @throws {429} Too many wrong passwords for this account
 * @throws {500} A file would not leave the archive; the account is still there.
 *   Or the files went and the rows did not; a retry finishes it.
 */
router.delete('/me', auth, currentPasswordLimit, upload.none(), async (req, res) => {
  try {
    const currentPassword = readCurrentPassword(req);
    if (!currentPassword) return response.badRequest(res, 'Current password is required');

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, role: true, password_hash: true },
    });
    if (!user) return response.notFound(res, 'User not found');

    const wrong = await currentPasswordRefusal(user, currentPassword);
    if (wrong) return response.forbidden(res, wrong);

    const adminCount = user.role === 'ADMIN' ? await prisma.user.count({ where: { role: 'ADMIN' } }) : 0;
    const refusal = accountDeletionRefusal(user, adminCount);
    if (refusal) return response.error(res, refusal.status, refusal.message);

    // Files first. A photograph removed is gone for good, so nothing else is
    // deleted until all of them are; a failure leaves an account a retry can
    // finish, never rows gone and files left with nothing pointing at them.
    const media = await removeAccountMedia(prisma, user.id);
    if (!media.ok) {
      return response.serverError(
        res,
        'Some of your photos and videos could not be removed, so your account has not been deleted. Try again.',
      );
    }

    // The files are already gone for good. If the rows now fail, say so: the
    // catch-all's "Internal server error" read as if nothing had happened,
    // and a retry is what finishes it.
    try {
      await prisma.$transaction(accountDeletionOperations(prisma, user.id));
    } catch (error) {
      // Two overlapping deletes (a double click, a retry after a timeout):
      // both pass the read above, the first commits, and the second's
      // user.delete finds no row. The account is gone, which is what was
      // asked, so that is a success, not a "try again" that then 404s.
      if (error?.code === 'P2025' && !(await prisma.user.findUnique({ where: { id: user.id }, select: { id: true } }))) {
        forgetPasswordChange(user.id);
        return response.success(res, 200, {}, 'Account deleted');
      }
      console.error('Error deleting account rows after its files were removed:', error);
      return response.serverError(
        res,
        'Your photos and videos were removed, but your account could not be deleted. Try again to finish.',
      );
    }
    // Its login tokens are refused from the next request on (THO-898), not
    // after the minute the cache would otherwise keep the row it read.
    forgetPasswordChange(user.id);
    await removeDerivedCopies(prisma, media.sha256s);

    return response.success(res, 200, {}, 'Account deleted');
  } catch (error) {
    console.error('Error deleting account:', error);
    return response.serverError(res, 'Internal server error');
  }
});

module.exports = router;
