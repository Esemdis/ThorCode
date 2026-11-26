const jwt = require('jsonwebtoken');
const { isLoginToken, loginTokenRefusal } = require('./loginRevocation');
const { tokenLifetimeVerdict, serviceTokenCheck } = require('./serviceTokens');
const { tokenScopeVerdict } = require('./tokenScopes');

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
  // A token with neither `jti` nor `exp` was minted before THO-1016 and can
  // never be withdrawn, so it is refused (auth/serviceTokens.js has why).
  const lifetime = tokenLifetimeVerdict(decoded);
  if (lifetime === 'refuse') return res.status(401).json({ error: 'Invalid or expired token' });
  // A scoped token reaches only its own calls (auth/tokenScopes.js, THO-972).
  // Checked before the row is read, so a wander token sent somewhere it may
  // not go costs no database read.
  const scope = tokenScopeVerdict(decoded, req.method, req.originalUrl);
  if (scope === 'unknown') return res.status(401).json({ error: 'Invalid or expired token' });
  if (scope === 'forbidden') return res.status(403).json({ error: 'Forbidden: this token can only read travel-bag trips for wander' });

  // Minted tokens (`jti`) are checked against their row (auth/serviceTokens.js),
  // with the same answer for every refusal so a caller cannot tell a withdrawn
  // token from one that never existed. Login tokens are checked against the
  // account's password state (auth/loginRevocation.js), and say why.
  const minted = lifetime === 'lookup';
  if (!minted && !isLoginToken(decoded)) {
    req.user = decoded; // Attach the decoded user information to the request object
    return next();
  }

  return (minted ? serviceTokenCheck(decoded) : loginTokenRefusal(decoded)).then(
    (refusal) => {
      if (refusal) return res.status(401).json({ error: minted ? 'Invalid or expired token' : refusal });
      req.user = decoded;
      return next();
    },
    (err) => {
      // A 500, not a 401: the token may be fine, and a 401 says it is dead
      // (concert-map signs the user out on one), so a database blip must not
      // end a session or look like a withdrawal.
      console.error('Error checking a token against the database:', err);
      return res.status(500).json({ error: 'Internal server error' });
    },
  );
};
