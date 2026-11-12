const jwt = require('jsonwebtoken');
const { isLoginToken, loginTokenRefusal } = require('./loginRevocation');

const ROLES = new Set(['USER', 'ADMIN', 'SYSTEM']);

module.exports = function (req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // A valid signature says who minted a token, not that it is a session.
  // Routes scope their queries with `where: { user_id: req.user.id }`, and
  // Prisma reads an undefined value there as no filter at all, so anything
  // signed with this secret but lacking a string id would read as a caller
  // who owns every row. An OAuth state was exactly that until it got its own
  // key; this is what stops the next such token from being one.
  if (typeof decoded?.id !== 'string' || !decoded.id || !ROLES.has(decoded.role)) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Service and other long-lived tokens never reach the database here, so
  // python-crohn and wander keep working whatever happens to the password
  // (auth/loginRevocation.js has why).
  if (!isLoginToken(decoded)) {
    req.user = decoded; // Attach the decoded user information to the request object
    return next();
  }

  return loginTokenRefusal(decoded).then(
    (refusal) => {
      if (refusal) return res.status(401).json({ error: refusal });
      req.user = decoded;
      return next();
    },
    (err) => {
      // A 500, not a 401: the token may be fine, and concert-map signs the
      // user out on any 401, so a database blip must not end every session.
      console.error('Error checking a login token against the password change:', err);
      return res.status(500).json({ error: 'Internal server error' });
    },
  );
};
