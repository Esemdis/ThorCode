module.exports = function (allowedRoles = []) {
  return (req, res, next) => {
    // No default role. A token that carries none is not a USER token — it is a
    // token that was never meant to reach a route, and defaulting it to USER is
    // how an OAuth state got waved through as one.
    const role = req.user?.role;
    if (!role || !allowedRoles.includes(role)) {
      return res
        .status(403)
        .json({ error: 'Forbidden: insufficient permissions' });
    }
    next();
  };
};
