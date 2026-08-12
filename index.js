const express = require("express");
const cors = require('cors');
const dotenv = require("dotenv").config();
const { startCronJobs } = require("./utils/cron");
const app = express();
const port = process.env.PORT || 4000;

app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use("/users", require("./routes/users"));
app.use("/data/steam", require("./routes/data/steam"));
app.use("/data/concerts", require("./routes/data/ticketmaster"))
app.use("/data/concerts", require("./routes/data/notifications"))
app.use("/data/concerts", require("./routes/data/playlists"))
app.use("/data/cities", require("./routes/data/cities"))
app.use("/data/tmdb", require("./routes/data/tmdb"));
app.use("/oauth/tmdb", require("./routes/oauth/tmdb"));
app.use("/oauth/spotify", require("./routes/oauth/spotify"));
// Every /travel/* route, read or write, passes the limiter first.
app.use("/travel", require("./middlewares/travelLimits"));
app.use("/travel/trips", require("./routes/travel/trips"));
app.use("/travel/trips/:tripId/items", require("./routes/travel/tripItems"));
app.use("/travel/trips/:tripId/todos", require("./routes/travel/tripTodos"));
app.use("/travel/trips/:tripId/places", require("./routes/travel/tripPlaces"));
app.use("/travel/trips/:tripId/plan", require("./routes/travel/tripPlan"));
app.use("/travel/trips/:tripId/estimates", require("./routes/travel/estimates"));
app.use("/travel/trips/:tripId/reviews", require("./routes/travel/reviews"));
app.use("/travel/trips/:tripId/trip-review", require("./routes/travel/tripReview"));
app.use("/travel/reviews", require("./routes/travel/allReviews"));
app.use("/travel/rates", require("./routes/travel/rates"));
app.use("/travel/gear", require("./routes/travel/gear"));
app.use("/travel/wishlist", require("./routes/travel/wishlist"));
app.use("/travel/loadouts", require("./routes/travel/loadouts"));
// Anything that escapes a route. A deliberate 4xx keeps its message — it was
// written to be read — but a 500 is an internal detail (table names, constraint
// names, sometimes values), so outside development the client just gets told it
// broke and the log keeps the rest.
app.use((err, req, res, _next) => {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`, err);
  const status = err.status ?? 500;
  const message = status < 500 || process.env.NODE_ENV !== 'production'
    ? err.message || 'Internal server error'
    : 'Internal server error';
  res.status(status).json({ error: message });
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
  startCronJobs();
});
