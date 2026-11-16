#!/usr/bin/env node
// Configures the Admin Panel + Backend deployment for your Firebase project.
//   npm run configure -- <PROJECT_ID> [--region asia-south1] [--admin-site <id>] [--user-url <url>]
//
// Sets: .firebaserc, firebase.json (admin hosting site + function region),
// backend/index.js (region) and the URLs in backend/.env.
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const project = args.find((a, i) => !a.startsWith("--") && !(args[i - 1] || "").startsWith("--"));
const opt = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
if (!project || !/^[a-z0-9-]{4,30}$/.test(project)) {
  console.error("Usage: npm run configure -- <PROJECT_ID> [--region asia-south1] [--admin-site <id>] [--user-url <url>]");
  process.exit(1);
}
const region = opt("region", "asia-south1");
const adminSite = opt("admin-site", `${project}-admin`);
// URL of the separately deployed User Panel (default: <project>-user site)
const userUrl = opt("user-url", `https://${project}-user.web.app`).replace(/\/$/, "");
const adminUrl = `https://${adminSite}.web.app`;
const root = path.join(__dirname, "..");
const file = (p) => path.join(root, p);

fs.writeFileSync(file(".firebaserc"), JSON.stringify({ projects: { default: project } }, null, 2) + "\n");

const fb = JSON.parse(fs.readFileSync(file("firebase.json"), "utf8"));
fb.hosting.site = adminSite;
for (const r of fb.hosting.rewrites) if (r.function) r.function.region = region;
fs.writeFileSync(file("firebase.json"), JSON.stringify(fb, null, 2) + "\n");

const idx = file("backend/index.js");
fs.writeFileSync(idx, fs.readFileSync(idx, "utf8").replace(/const REGION = "[^"]*";/, `const REGION = "${region}";`));

const userOrigins = [userUrl];
const m = /^https:\/\/([a-z0-9-]+)\.web\.app$/.exec(userUrl);
if (m) userOrigins.push(`https://${m[1]}.firebaseapp.com`);
const values = {
  ADMIN_PANEL_URL: adminUrl,
  USER_PANEL_URL: userUrl,
  // The API is served at <admin site>/api through the Hosting rewrite.
  BACKEND_URL: adminUrl,
  // Only the User Panel calls the API from another domain.
  FRONTEND_ORIGINS: userOrigins.join(","),
};
const envPath = file("backend/.env");
let env = fs.readFileSync(envPath, "utf8");
for (const [key, value] of Object.entries(values)) {
  const re = new RegExp(`^${key}=.*$`, "m");
  env = re.test(env) ? env.replace(re, `${key}=${value}`) : env + `\n${key}=${value}\n`;
}
// Firebase refuses to deploy when .env sets a reserved key such as PORT.
const reserved = /^(PORT|K_SERVICE|K_REVISION|K_CONFIGURATION|FUNCTION_TARGET|FUNCTION_SIGNATURE_TYPE|FIREBASE_CONFIG|GCLOUD_PROJECT|X_GOOGLE_[A-Z_]*)\s*=.*\n?/gm;
if (reserved.test(env)) {
  env = env.replace(reserved, "");
  console.log("Removed reserved keys (e.g. PORT) from backend/.env — Firebase does not allow them.");
}
fs.writeFileSync(envPath, env);

console.log(`Admin Panel + Backend configured for "${project}" (${region}).
  Admin panel   ${adminUrl}
  API           ${adminUrl}/api   (use this as the User Panel's API URL)
  User panel    ${userUrl}   (allowed to call the API)
Next: put DATABASE_URL, ADMIN_* and SMTP values in backend/.env, then
      firebase hosting:sites:create ${adminSite}   (first time only)
      firebase deploy`);
