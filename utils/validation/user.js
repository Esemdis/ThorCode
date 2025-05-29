const { body } = require("express-validator");

const userValidation = [
  body("email").isEmail().withMessage("Valid email required"),
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
module.exports = userValidation;
