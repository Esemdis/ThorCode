const express = require("express");
const cors = require('cors');
const dotenv = require("dotenv").config();
const app = express();
const port = 4000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use("/users", require("./routes/users"));
app.use("/data/steam", require("./routes/data/steam"));
app.use("/data/concerts", require("./routes/data/ticketmaster"))
app.use("/data/cities", require("./routes/data/cities"))
app.use("/data/tmdb", require("./routes/data/tmdb"));
app.use("/oauth/tmdb", require("./routes/oauth/tmdb"));
app.use("/travel/trips", require("./routes/travel/trips"));
app.use("/travel/trips/:tripId/items", require("./routes/travel/tripItems"));
app.use("/travel/trips/:tripId/estimates", require("./routes/travel/estimates"));
app.use("/travel/trips/:tripId/reviews", require("./routes/travel/reviews"));
app.use("/travel/reviews", require("./routes/travel/allReviews"));
app.use("/travel/rates", require("./routes/travel/rates"));
app.use("/travel/gear", require("./routes/travel/gear"));
app.use("/travel/wishlist", require("./routes/travel/wishlist"));
app.use("/travel/loadouts", require("./routes/travel/loadouts"));
app.use((err, req, res, _next) => {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`, err);
  res.status(err.status ?? 500).json({ error: err.message || 'Internal server error' });
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
