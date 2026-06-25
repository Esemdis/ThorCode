module.exports = function (allowedRoles = []) {
  return (req, res, next) => {
    const role = req.user?.role || 'USER';
    if (!req.user || !allowedRoles.includes(role)) {
      return res
        .status(403)
        .json({ error: 'Forbidden: insufficient permissions' });
    }
    next();
  };
};
