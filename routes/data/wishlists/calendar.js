/**
 * The subscribable calendar feed token.
 *
 * Split out of routes/data/wishlists.js, which had grown to 1473 lines and
 * twenty-one endpoints. wishlists.js mounts this and its siblings in their
 * original declaration order — the manifest test in wishlists.test.js pins
 * the resulting surface.
 */
const express = require("express");
const router = express.Router();
const { validationResult, param, body } = require("express-validator");
const auth = require("../../../auth/verifyJWT");
const roleCheck = require("../../../middlewares/roleCheck");
const prisma = require("../../../prisma/client");
const { generateCalendarToken, feedUrl, isPubliclyReachable } = require("../../../utils/calendarToken");

//
// Minted lazily rather than for every wishlist: most users never subscribe, and
// a row full of unused credentials is a liability rather than a feature.
const ownedWishlist = async (req, res) => {
  const wishlistId = parseInt(req.params.id, 10);
  const wishlist = await prisma.wishlist.findUnique({
    where: { id: wishlistId },
    select: { id: true, user_id: true, calendar_token: true, calendar_token_at: true },
  });
  if (!wishlist) { res.status(404).json({ error: "Not found" }); return null; }
  if (wishlist.user_id !== req.user.id) { res.status(403).json({ error: "Forbidden" }); return null; }
  return wishlist;
};

// GET /wishlists/:id/calendar-token — the current feed URL, if one exists
router.get(
  "/wishlists/:id/calendar-token",
  [auth, roleCheck(["ADMIN", "USER"]), param("id").isInt().withMessage("Wishlist ID must be an integer")],
  async (req, res) => {
    try {
      const wishlist = await ownedWishlist(req, res);
      if (!wishlist) return;
      if (!wishlist.calendar_token) return res.json({ token: null, url: null });
      return res.json({
        token: wishlist.calendar_token,
        url: feedUrl(process.env.CALLBACK_URL, wishlist.calendar_token),
        created_at: wishlist.calendar_token_at,
        // Reported rather than assumed: on a development config this URL is
        // loopback, which no calendar service can fetch.
        publicly_reachable: isPubliclyReachable(process.env.CALLBACK_URL),
      });
    } catch (error) {
      console.error("Error reading calendar token:", error);
      res.status(500).json({ error: "Failed to read calendar token" });
    }
  },
);

// POST /wishlists/:id/calendar-token — create one, or return the existing one
router.post(
  "/wishlists/:id/calendar-token",
  [auth, roleCheck(["ADMIN", "USER"]), param("id").isInt().withMessage("Wishlist ID must be an integer")],
  async (req, res) => {
    try {
      const wishlist = await ownedWishlist(req, res);
      if (!wishlist) return;

      // Create-or-return, so the client never has to ask whether one exists
      // first. Rotating is an explicit DELETE then POST — issuing a new token
      // here would silently break every calendar already subscribed.
      const token = wishlist.calendar_token ?? generateCalendarToken();
      if (!wishlist.calendar_token) {
        await prisma.wishlist.update({
          where: { id: wishlist.id },
          data: { calendar_token: token, calendar_token_at: new Date() },
        });
      }
      return res.json({
        token,
        url: feedUrl(process.env.CALLBACK_URL, token),
        publicly_reachable: isPubliclyReachable(process.env.CALLBACK_URL),
      });
    } catch (error) {
      console.error("Error creating calendar token:", error);
      res.status(500).json({ error: "Failed to create calendar token" });
    }
  },
);

// DELETE /wishlists/:id/calendar-token — revoke; every subscription stops
router.delete(
  "/wishlists/:id/calendar-token",
  [auth, roleCheck(["ADMIN", "USER"]), param("id").isInt().withMessage("Wishlist ID must be an integer")],
  async (req, res) => {
    try {
      const wishlist = await ownedWishlist(req, res);
      if (!wishlist) return;
      await prisma.wishlist.update({
        where: { id: wishlist.id },
        data: { calendar_token: null, calendar_token_at: null },
      });
      return res.status(204).end();
    } catch (error) {
      console.error("Error revoking calendar token:", error);
      res.status(500).json({ error: "Failed to revoke calendar token" });
    }
  },
);

module.exports = router;
