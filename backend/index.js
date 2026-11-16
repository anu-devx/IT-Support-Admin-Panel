// Firebase Cloud Functions (2nd gen) entry point — deployed on its own with
// `firebase deploy --only functions` from this folder.
//
// Public URL: https://<REGION>-<PROJECT_ID>.cloudfunctions.net/api
// (also https://api-<hash>.a.run.app). The panels call <URL>/api/... .
const { onRequest } = require("firebase-functions/v2/https");
const { app } = require("./src/app");

const REGION = "asia-south1"; // Mumbai — set by `npm run configure -- --region ...`

exports.api = onRequest(
  {
    region: REGION,
    timeoutSeconds: 300,
    memory: "512MiB",
    concurrency: 80,
    maxInstances: 5,
    invoker: "public", // the panels call this API directly from the browser
  },
  (req, res) => {
    // Depending on which URL is used (cloudfunctions.net, run.app or the
    // emulator), the function name may or may not still be on the path.
    // Normalise so Express always sees /api/... .
    if (req.url.startsWith("/api/api/") || req.url === "/api/api") req.url = req.url.slice(4);
    else if (!req.url.startsWith("/api/") && req.url !== "/api") req.url = "/api" + (req.url === "/" ? "" : req.url);
    return app(req, res);
  },
);
