const { body } = require("express-validator");
const { normaliseEmail } = require("./email");

// The rules a new password has to meet, on their own so a password reset holds
// a password to exactly what registering does (THO-808). Kept in one place:
// two copies would drift, and an account reset to a password register would
// refuse is an account the rules no longer describe.
const passwordValidation = [
  body("password")
    .isLength({ min: 8, max: 100 })
    .withMessage(
      "Password must be at least 8 characters, at most 100 characters"
    )
    .matches(/[A-Z]/)
    .withMessage("Password must contain at least one uppercase letter")
    .matches(/[a-z]/)
    .withMessage("Password must contain at least one lowercase letter"),
];

const userValidation = [
  // Normalised before it is checked, so every route below reads the address
  // as it is stored. See normaliseEmail.
  body("email").customSanitizer(normaliseEmail).isEmail().withMessage("Valid email required"),
  ...passwordValidation,
];
module.exports = userValidation;
module.exports.passwordValidation = passwordValidation;
