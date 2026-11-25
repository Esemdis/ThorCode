const jwt = require('jsonwebtoken');
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

  // Login tokens never reach the database here: `exp` already ends them.
  if (lifetime !== 'lookup') {
    req.user = decoded; // Attach the decoded user information to the request object
    return next();
  }

  return serviceTokenCheck(decoded).then(
    (refusal) => {
      // The same answer for every refusal, so a caller cannot tell a
      // withdrawn token from one that never existed.
      if (refusal) return res.status(401).json({ error: 'Invalid or expired token' });
      req.user = decoded;
      return next();
    },
    (err) => {
      // A 500, not a 401: the token may be fine, and a 401 says it is dead,
      // so a database blip must not look like a withdrawal.
      console.error('Error checking a minted token against its row:', err);
      return res.status(500).json({ error: 'Internal server error' });
    },
  );
};
