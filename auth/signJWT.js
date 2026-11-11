const jwt = require("jsonwebtoken");
const { LOGIN_TOKEN_KIND } = require("./loginRevocation");

module.exports = function ({ user }) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      // Marks a session from the login route, the only kind a password reset
      // ends (THO-898, auth/loginRevocation.js).
      kind: LOGIN_TOKEN_KIND,
    },
    process.env.JWT_SECRET,
    { expiresIn: "8h" }
  );
};
