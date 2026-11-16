// Local / container entry point: `npm run dev` or `npm start`.
require("./env");
const { app } = require("./app");
const pool = require("./config/db");
const port = Number(process.env.PORT || 5000);
pool
  .query("SELECT 1")
  .then(() =>
    app.listen(port, () => console.log(`Helpdesk API listening on http://localhost:${port}`)),
  )
  .catch((e) => {
    console.error("PostgreSQL connection failed:", e.message);
    process.exit(1);
  });
