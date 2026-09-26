const jwt = require('jsonwebtoken');

const ROLES = new Set(['USER', 'ADMIN', 'SYSTEM']);

module.exports = function (req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    // A valid signature says who minted a token, not that it is a session.
    // Routes scope their queries with `where: { user_id: req.user.id }`, and
    // Prisma reads an undefined value there as no filter at all, so anything
    // signed with this secret but lacking a string id would read as a caller
    // who owns every row. An OAuth state was exactly that until it got its own
    // key; this is what stops the next such token from being one.
    if (typeof decoded?.id !== 'string' || !decoded.id || !ROLES.has(decoded.role)) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = decoded; // Attach the decoded user information to the request object
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
