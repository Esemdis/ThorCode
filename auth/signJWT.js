const jwt = require("jsonwebtoken");
const { LOGIN_TOKEN_KIND, passwordChangeStamp } = require("./loginRevocation");

/**
 * A login token. `passwordChangedAt` is the account's `password_changed_at`
 * as read with the hash that was just checked (or as just written), so a
 * reset or change committed after that read ends this token too (THO-898,
 * auth/loginRevocation.js).
 */
module.exports = function ({ user, passwordChangedAt = null }) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      // Marks a session from a route that checked a password, the only kind a
      // password reset ends.
      kind: LOGIN_TOKEN_KIND,
      pwc: passwordChangeStamp(passwordChangedAt),
    },
    process.env.JWT_SECRET,
    { expiresIn: "8h" }
  );
};
