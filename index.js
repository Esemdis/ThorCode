const express = require("express");
const dotenv = require("dotenv").config();
const app = express();
const port = 3000;

app.use(express.urlencoded({ extended: true }));
app.use("/users", require("./routes/users"));
app.use("/data/steam", require("./routes/data/steam"));
app.use("/data/tmdb", require("./routes/data/tmdb"));
app.use("/oauth/tmdb", require("./routes/oauth/tmdb"));
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
