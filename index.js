const express = require("express");
const app = express();
const port = 3000;
app.use(express.urlencoded({ extended: true }));
app.use("/users", require("./routes/users"));

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
