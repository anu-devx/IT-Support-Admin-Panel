// Loads configuration for local runs (npm run dev / npm start / npm run setup).
// .env.local (local machine values) wins over .env (deployed values).
// On Firebase Cloud Functions the platform loads .env itself, so this file
// is not used there.
const path = require("node:path");
require("dotenv").config({
  path: [path.join(__dirname, "..", ".env.local"), path.join(__dirname, "..", ".env")],
  quiet: true,
});
