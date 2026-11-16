const express = require("express");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);
const pool = require("./config/db");
const nodemailer = require("nodemailer");
const app = express();
const mailer = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || "false") === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined,
    })
  : null;
// Sender address: MAIL_FROM, or the SMTP account itself when MAIL_FROM is
// not set (Gmail always sends from the authenticated account anyway).
const mailFrom = () =>
  (process.env.MAIL_FROM || "").trim() ||
  (process.env.SMTP_USER ? `IT Support Portal <${process.env.SMTP_USER.trim()}>` : "");
if (!mailer || !mailFrom())
  console.warn("Email is not configured (set SMTP_HOST, SMTP_USER, SMTP_PASSWORD). Sign-up verification and password reset emails cannot be sent.");
async function sendAccountMail(to, subject, html) {
  if (!mailer || !mailFrom())
    throw fail(503, "Email delivery is not configured. Ask the administrator to configure SMTP.");
  try {
    await mailer.sendMail({ from: mailFrom(), to, subject, html });
  } catch (error) {
    // Show the real reason in the server log and a clear message in the UI
    // instead of a generic server error.
    console.error("Sending email failed:", error.code || "", error.message);
    const authProblem = error.code === "EAUTH" || error.responseCode === 535;
    throw fail(
      503,
      authProblem
        ? "Email could not be sent: the SMTP login was rejected. For Gmail, use a 16-character App Password in SMTP_PASSWORD."
        : "Email could not be sent right now. Please try again in a few minutes.",
    );
  }
}
// Each panel has its own public URL. Links in emails must open the panel the
// request came from (previously every reset link pointed at FRONTEND_URL,
// which was the admin panel, so employees could not finish a reset).
const trimUrl = (u) => (u || "").trim().replace(/\/$/, "");
function panelUrl(panel) {
  const url =
    panel === "admin"
      ? trimUrl(process.env.ADMIN_PANEL_URL)
      : trimUrl(process.env.USER_PANEL_URL);
  return url || trimUrl(process.env.FRONTEND_URL);
}
function accountLink(panel, path, token) {
  const base = panelUrl(panel);
  if (!base) throw fail(503, "USER_PANEL_URL / ADMIN_PANEL_URL is not configured.");
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}
// Where the API is reachable from the browser. On Firebase Hosting the API is
// served under each panel's own domain (/api rewrite), so the user panel URL
// works when BACKEND_URL is not set.
const publicApiBase = () => trimUrl(process.env.BACKEND_URL) || panelUrl("user");

app.disable("x-powered-by");
// Firebase Hosting / Cloud Run / Render sit behind a proxy. Without this,
// req.ip is the proxy's address and every visitor shares one rate-limit bucket.
app.set("trust proxy", true);
const allowedOrigins = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && allowedOrigins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Access-Control-Allow-Headers", "Content-Type, X-Portal, X-Auth-Mode, Authorization");
    res.set("Access-Control-Max-Age", "600");
    res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    res.set("Vary", "Origin");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "3mb" }));
app.use((req, res, next) => {
  if (!req.body || typeof req.body !== "object") req.body = {};
  next();
});
const digest = (t) => crypto.createHash("sha256").update(t).digest("hex");
async function hash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + (await scrypt(password, salt, 64)).toString("hex");
}
async function verify(password, stored) {
  const [salt, key] = String(stored || "").split(":");
  if (!salt || !key) return false; // not a scrypt hash from this app
  const actual = await scrypt(password, salt, 64);
  const expected = Buffer.from(key, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}
const DEPARTMENTS = [
  "HR Department",
  "MERN Stack",
  "QA Testing",
  "AI Team",
  "DevOps",
  "BDE",
  "Customer Support",
  "Finance and Accounting",
];
const publicUser = (u) => ({
  name: u.name,
  email: u.email,
  employeeId: u.employee_id,
  company: u.company,
  department: u.department || null,
  avatar: u.avatar || null,
  role: u.role,
  joinedAt: u.created_at ? new Date(u.created_at).toISOString().slice(0, 10) : null,
});
// Sessions: each panel keeps its own session row (sessions.panel), so signing
// in or out of one panel never affects the other.
//
// Firebase Hosting forwards ONLY a cookie named "__session" to Cloud
// Functions and strips every other cookie. The old per-panel cookie names
// (helpdesk_user_session / helpdesk_admin_session) therefore never reached the
// API in production and every request returned 401. Both panel tokens now
// live inside the single "__session" cookie as "user.<token>~admin.<token>".
// This also keeps the panels independent on localhost, where browsers share
// cookies across ports.
const SESSION_COOKIE = "__session";
const LEGACY_COOKIES = { user: "helpdesk_user_session", admin: "helpdesk_admin_session" };
const panelOf = (req) => (req.get("x-portal") === "admin" ? "admin" : "user");
const sameSite = (process.env.COOKIE_SAME_SITE || "lax").toLowerCase();
const cookieOptions = {
  httpOnly: true,
  sameSite,
  // SameSite=None requires Secure. Local development over http uses
  // NODE_ENV=development so the cookie is not marked Secure.
  secure:
    sameSite === "none" ||
    (process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === "true"
      : process.env.NODE_ENV !== "development"),
  path: "/",
};
function readCookie(req, name) {
  const raw = (req.headers.cookie || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(name + "="))
    ?.slice(name.length + 1);
  if (raw === undefined) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
function sessionParts(req) {
  const parts = {};
  for (const piece of (readCookie(req, SESSION_COOKIE) || "").split("~")) {
    const [panel, token] = piece.split(".");
    if ((panel === "user" || panel === "admin") && /^[a-f0-9]{64}$/.test(token || ""))
      parts[panel] = token;
  }
  return parts;
}
function bearerToken(req) {
  const m = /^Bearer ([a-f0-9]{64})$/i.exec(req.get("authorization") || "");
  return m ? m[1].toLowerCase() : undefined;
}
// Panels deployed on a different domain from the API (separate deployment)
// send the session token as "Authorization: Bearer <token>" because browsers
// increasingly block cross-site cookies. Same-domain setups use the cookie.
function readSessionToken(req, panel) {
  return bearerToken(req) || sessionParts(req)[panel] || readCookie(req, LEGACY_COOKIES[panel]);
}
function writeSessionCookie(res, parts) {
  const value = Object.entries(parts)
    .filter(([, token]) => token)
    .map(([panel, token]) => `${panel}.${token}`)
    .join("~");
  if (value) res.cookie(SESSION_COOKIE, value, { ...cookieOptions, maxAge: 604800000 });
  else res.clearCookie(SESSION_COOKIE, cookieOptions);
}
function setSessionToken(req, res, panel, token) {
  writeSessionCookie(res, { ...sessionParts(req), [panel]: token });
  res.clearCookie(LEGACY_COOKIES[panel], cookieOptions);
}
function clearSessionToken(req, res, panel) {
  const parts = sessionParts(req);
  delete parts[panel];
  writeSessionCookie(res, parts);
  res.clearCookie(LEGACY_COOKIES[panel], cookieOptions);
}
const fail = (status, message) => Object.assign(new Error(message), { status });
function text(v, max) {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max)
    throw fail(400, "Required fields are missing or too long");
  return v.trim();
}
function department(v, { required = false } = {}) {
  if ((v === undefined || v === null || v === "") && !required) return null;
  if (!DEPARTMENTS.includes(v)) throw fail(400, "Please select a valid department");
  return v;
}
const attempts = new Map();
// Only credential-guessing endpoints are rate limited. Previously every
// /api/auth/* call (including the /auth/me check on each page load and
// profile saves) counted, so normal use locked people out.
const LIMITED = new Set(["/login", "/signup", "/forgot-password", "/reset-password"]);
app.use("/api/auth", (req, res, next) => {
  if (req.method !== "POST" || !LIMITED.has(req.path)) return next();
  const key = req.ip + ":" + req.path;
  const now = Date.now();
  let a = attempts.get(key);
  if (!a || a.until < now) {
    a = { count: 0, until: now + 900000 };
    attempts.set(key, a);
  }
  if (a.count >= Number(process.env.AUTH_RATE_LIMIT || 30))
    return res
      .status(429)
      .json({ message: "Too many attempts. Try again in 15 minutes." });
  // Only failed attempts count, so colleagues behind one office IP signing in
  // successfully never lock each other out. Forgot-password always counts
  // (it always answers 200) to limit email flooding.
  res.on("finish", () => {
    if (res.statusCode >= 400 || req.path === "/forgot-password") a.count++;
  });
  next();
});
setInterval(() => {
  for (const [k, v] of attempts) if (v.until < Date.now()) attempts.delete(k);
}, 60000).unref();
async function session(req, res, u) {
  const panel = panelOf(req);
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at,panel) VALUES ($1,$2,now()+interval '7 days',$3)",
    [digest(token), u.id, panel],
  );
  setSessionToken(req, res, panel, token);
  // Token mode (cross-domain panels): hand the token to the client as well.
  if (req.get("x-auth-mode") === "token") res.locals.sessionToken = token;
  // Housekeeping: expired sessions were never removed before.
  pool.query("DELETE FROM sessions WHERE expires_at < now()").catch(() => {});
  return publicUser(u);
}
async function sendVerification(user) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO email_verification_tokens(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '24 hours')",
    [digest(rawToken), user.id],
  );
  const verifyUrl = `${publicApiBase()}/api/auth/verify-email?token=${encodeURIComponent(rawToken)}`;
  await sendAccountMail(
    user.email,
    "Verify your IT Support account",
    `<p>Hello ${String(user.name).replace(/[&<>"]/g, "")},</p><p>Verify your email address to activate your IT Support account.</p><p><a href="${verifyUrl}">Verify email address</a></p><p>This link expires in 24 hours.</p>`,
  );
}
app.get("/api/health", async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "OK" });
});
app.get("/api/departments", (req, res) => res.json(DEPARTMENTS));
// ── Invitation-only sign-up ────────────────────────────────────────────────
// The administrator registers an employee (name, Employee ID, department and
// email) in employee_profiles and an invitation email with a unique, expiring,
// single-use link is sent. Only that link can create an Employee Panel account.
const INVITE_DAYS = 7;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const escapeHtml = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const PROFILE_COLUMNS = `id,employee_id,name,email,department,created_at,invited_at,registered_at,
  CASE WHEN registered_at IS NOT NULL THEN 'Registered'
       WHEN email IS NULL THEN 'No email'
       WHEN invite_expires_at IS NULL OR invite_expires_at < now() THEN 'Invite expired'
       ELSE 'Invited' END AS status`;
// Creates a fresh single-use token for the profile (replacing any older link)
// and emails it. Used for both the first invitation and "Resend".
async function issueInvite(profile) {
  const base = panelUrl("user");
  if (!base) throw fail(503, "USER_PANEL_URL is not configured.");
  const rawToken = crypto.randomBytes(32).toString("hex");
  await pool.query(
    `UPDATE employee_profiles SET invite_token_hash=$1, invite_expires_at=now()+interval '${INVITE_DAYS} days', invited_at=now() WHERE id=$2`,
    [digest(rawToken), profile.id],
  );
  const link = `${base}/signup?invite=${rawToken}`;
  await sendAccountMail(
    profile.email,
    "You're invited to the IT Support Portal",
    `<p>Hello ${escapeHtml(profile.name)},</p>
<p>Your administrator has created an IT Support Portal profile for you (Employee ID <b>${escapeHtml(profile.employee_id)}</b>, ${escapeHtml(profile.department)}).</p>
<p><a href="${link}">Create your account</a></p>
<p>This link is personal to you, can be used once and expires in ${INVITE_DAYS} days. If you were not expecting this email, you can ignore it.</p>`,
  );
}
app.get("/api/auth/invite", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token.trim().slice(0, 128) : "";
  const { rows } = token
    ? await pool.query(
        "SELECT employee_id,name,email,department FROM employee_profiles WHERE invite_token_hash=$1 AND email IS NOT NULL AND registered_at IS NULL AND invite_expires_at>now()",
        [digest(token)],
      )
    : { rows: [] };
  if (!rows[0])
    throw fail(400, "This invitation link is invalid or has expired. Ask your administrator to send a new one.");
  res.json({ employeeId: rows[0].employee_id, name: rows[0].name, email: rows[0].email, department: rows[0].department });
});
app.post("/api/auth/signup", async (req, res) => {
  if (panelOf(req) === "admin")
    throw fail(403, "Admin accounts cannot be created from the admin panel");
  const inviteToken = typeof req.body.inviteToken === "string" ? req.body.inviteToken.trim().slice(0, 128) : "";
  // Sign-up is only possible with a valid invitation sent to a real email.
  if (!inviteToken)
    throw fail(403, "Sign-up is by invitation only. Use the link in the invitation email from your administrator.");
  const password = req.body.password;
  if (typeof password !== "string" || password.length < 10 || password.length > 128)
    throw fail(400, "Use a password of 10–128 characters");
  const company = typeof req.body.company === "string" ? req.body.company.trim().slice(0, 100) : "";
  const passwordHash = await hash(password);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    // Claim the invitation atomically so a link can only be used once.
    const claim = await c.query(
      "UPDATE employee_profiles SET registered_at=now(), invite_token_hash=NULL WHERE invite_token_hash=$1 AND email IS NOT NULL AND registered_at IS NULL AND invite_expires_at>now() RETURNING *",
      [digest(inviteToken)],
    );
    const profile = claim.rows[0];
    if (!profile)
      throw fail(403, "This invitation link is invalid, already used or expired. Ask your administrator to send a new one.");
    const name = typeof req.body.name === "string" && req.body.name.trim() ? text(req.body.name, 100) : profile.name;
    // Email, Employee ID and department come from the administrator's profile,
    // not from the form. The invitation reached this mailbox, so it is verified.
    const created = await c.query(
      "INSERT INTO users(employee_id,name,email,password_hash,company,department,email_verified) VALUES($1,$2,$3,$4,$5,$6,true) RETURNING id",
      [profile.employee_id, name, profile.email.toLowerCase(), passwordHash, company, profile.department],
    );
    await c.query("UPDATE employee_profiles SET user_id=$1 WHERE id=$2", [created.rows[0].id, profile.id]);
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
  res.status(201).json({ message: "Account created. You can sign in now." });
});

app.get("/api/auth/verify-email", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token.trim().slice(0, 128) : "";
  const { rows } = token
    ? await pool.query(
        "UPDATE email_verification_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING user_id",
        [digest(token)],
      )
    : { rows: [] };
  if (rows[0])
    await pool.query("UPDATE users SET email_verified=true WHERE id=$1", [rows[0].user_id]);
  // Send the employee back to the sign-in page with a clear message instead
  // of leaving them on a bare API page.
  const base = panelUrl("user");
  if (base) return res.redirect(303, `${base}/login?verified=${rows[0] ? "1" : "0"}`);
  if (!rows[0]) return res.status(400).send("This verification link is invalid or expired.");
  res.type("html").send("<main style='font:16px Arial;max-width:560px;margin:12vh auto;padding:24px'><h2>Email verified</h2><p>Your IT Support account is active. You can now sign in.</p></main>");
});
app.post("/api/auth/forgot-password", async (req, res) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const panel = panelOf(req);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const { rows } = await pool.query("SELECT id,email,role FROM users WHERE email=$1", [email]);
    // Admin-panel resets are only issued for administrator accounts.
    if (rows[0] && (panel !== "admin" || rows[0].role === "admin")) {
      const token = crypto.randomBytes(32).toString("hex");
      await pool.query(
        "INSERT INTO password_reset_tokens(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')",
        [digest(token), rows[0].id],
      );
      try {
        await sendAccountMail(
          rows[0].email,
          "Reset your IT Support password",
          `<p>A password reset was requested for your IT Support account.</p><p><a href="${accountLink(panel, "/reset-password", token)}">Reset password</a></p><p>This link expires in 30 minutes. If you did not request this, ignore this email.</p>`,
        );
      } catch (error) {
        console.error("Password reset email could not be sent:", error.message);
      }
    }
  }
  res.json({ message: "If that email is registered, a password reset link has been sent." });
});
app.post("/api/auth/reset-password", async (req, res) => {
  if (typeof req.body.token !== "string" || !req.body.token.trim())
    throw fail(400, "This password reset link is invalid or expired.");
  const token = text(req.body.token, 128);
  const password = req.body.password;
  if (typeof password !== "string" || password.length < 10 || password.length > 128)
    throw fail(400, "Use a password of 10–128 characters.");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const { rows } = await c.query(
      "UPDATE password_reset_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING user_id",
      [digest(token)],
    );
    if (!rows[0]) throw fail(400, "This password reset link is invalid or expired.");
    await c.query("UPDATE users SET password_hash=$1 WHERE id=$2", [await hash(password), rows[0].user_id]);
    await c.query("DELETE FROM sessions WHERE user_id=$1", [rows[0].user_id]);
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
  res.json({ message: "Password reset successfully. Please sign in with your new password." });
});
// Logout works even when the session has already expired, so the browser
// cookie is always cleared (it used to fail with 401 and leave it behind).
app.post("/api/auth/logout", async (req, res) => {
  const panel = panelOf(req);
  const token = readSessionToken(req, panel);
  if (token)
    await pool.query("DELETE FROM sessions WHERE token_hash=$1 AND panel=$2", [digest(token), panel]);
  clearSessionToken(req, res, panel);
  res.json({ message: "Signed out" });
});
app.post("/api/auth/login", async (req, res) => {
  const email = text(req.body.email, 254).toLowerCase();
  if (typeof req.body.password !== "string" || req.body.password.length > 128)
    throw fail(401, "Invalid credentials");
  const { rows } = await pool.query(
    "SELECT * FROM users WHERE email=$1 OR employee_id=$2",
    [email, req.body.email.trim().toUpperCase()],
  );
  if (!rows[0] || !(await verify(req.body.password, rows[0].password_hash)))
    throw fail(401, "Invalid credentials");
  if (rows[0].email_verified === false)
    throw fail(403, "Please verify your email using the link sent to your inbox. Need a new link? Sign up again with the same email.");
  if (panelOf(req) === "admin" && rows[0].role !== "admin")
    throw fail(403, "Please use an administrator account");
  const user = await session(req, res, rows[0]);
  res.json(res.locals.sessionToken ? { user, token: res.locals.sessionToken } : { user });
});
app.use("/api", async (req, res, next) => {
  const panel = panelOf(req);
  const token = readSessionToken(req, panel);
  if (!token) throw fail(401, "Please sign in");
  const { rows } = await pool.query(
    "SELECT u.*, s.token_hash AS session_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.panel=$2 AND s.expires_at>now()",
    [digest(token || ""), panel],
  );
  if (!rows[0]) throw fail(401, "Please sign in");
  // An admin session is only valid while the account is still an admin.
  if (panel === "admin" && rows[0].role !== "admin")
    throw fail(403, "Administrator access required");
  req.user = rows[0];
  req.panel = panel;
  next();
});
app.get("/api/auth/me", (req, res) => res.json({ user: publicUser(req.user) }));
app.patch("/api/auth/profile", async (req, res) => {
  const name = req.body.name === undefined ? req.user.name : text(req.body.name, 100);
  const company =
    typeof req.body.company === "string"
      ? req.body.company.trim().slice(0, 100)
      : req.user.company;
  const dept =
    req.body.department === undefined
      ? req.user.department
      : department(req.body.department, { required: req.user.role !== "admin" });
  // Once a department has been chosen it is fixed and cannot be changed.
  if (req.user.department && dept !== req.user.department)
    throw fail(403, "Your department is fixed and cannot be changed.");
  // Profile photo: a small image data URL, or null/"" to remove it.
  let avatar = req.user.avatar || null;
  if (req.body.avatar !== undefined) {
    const a = req.body.avatar;
    if (a === null || a === "") avatar = null;
    else if (typeof a === "string" && a.length <= 300000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(a)) avatar = a;
    else throw fail(400, "Unsupported photo. Use a JPEG, PNG or WebP image.");
  }
  const { rows } = await pool.query(
    "UPDATE users SET name=$1,company=$2,department=$3,avatar=$4 WHERE id=$5 RETURNING *",
    [name, company, dept, avatar, req.user.id],
  );
  // Tickets raised before a department was chosen join that department now.
  if (dept)
    await pool.query(
      "UPDATE helpdesk_tickets SET department=$1 WHERE user_id=$2 AND department IS NULL",
      [dept, req.user.id],
    );
  res.json({ user: publicUser(rows[0]) });
});
// Assets the administrator has assigned to the signed-in employee (matched by
// Employee ID). They appear here as soon as the admin assigns them.
app.get("/api/assets/mine", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id,name,asset_tag,category,status,notes,department,employee_id,
            created_at AS assigned_at,updated_at
       FROM assets
      WHERE regexp_replace(upper(employee_id),'[^A-Z0-9]','','g')=regexp_replace(upper($1),'[^A-Z0-9]','','g') AND status IN ('Assigned','Under Repair')
      ORDER BY created_at DESC, id DESC`,
    [req.user.employee_id],
  );
  res.json(rows);
});
function admin(req) {
  if (req.panel !== "admin" || req.user.role !== "admin")
    throw fail(403, "Administrator access required");
}
const statuses = ["Open", "Queued", "In Progress", "Resolved"];
// Admins (signed in on the admin panel) see every ticket; everyone else sees
// only tickets they own. Ownership is enforced here, in the SQL itself.
// Admins only see tickets that belong to a department (no "Unassigned" tickets).
// Status changes are stored on the ticket only, so the update list holds
// conversation messages; legacy "Status changed to …" rows are hidden.
async function getTickets(req, id, dept) {
  const all = req.panel === "admin" && req.user.role === "admin";
  const { rows } = await pool.query(
    `SELECT t.*,u.name,u.email,u.employee_id,COALESCE((SELECT json_agg(x.message || ' · ' || to_char(x.created_at,'YYYY-MM-DD HH24:MI') ORDER BY x.id) FROM ticket_updates x WHERE x.ticket_id=t.id AND x.message NOT LIKE 'Status changed to %'),'[]') AS updates FROM helpdesk_tickets t JOIN users u ON u.id=t.user_id WHERE (CASE WHEN $1::boolean THEN t.department IS NOT NULL ELSE t.user_id=$2 END) AND ($3::integer IS NULL OR t.id=$3) AND ($4::text IS NULL OR t.department=$4) ORDER BY t.id DESC`,
    [all, req.user.id, id || null, all ? dept || null : null],
  );
  return rows.map(({ user_id, ...t }) => ({
    ...t,
    id: "TKT-" + t.id,
    employeeId: t.employee_id,
    department: t.department || null,
    createdAt: t.created_at.toISOString().slice(0, 10),
    updatedAt: t.updated_at.toISOString().slice(0, 16).replace("T", " "),
  }));
}
function ticketId(req) {
  if (!/^(TKT-)?\d{1,9}$/i.test(String(req.params.id)))
    throw fail(400, "Invalid ticket ID");
  const id = Number(String(req.params.id).replace(/^TKT-/i, ""));
  if (!Number.isSafeInteger(id) || id < 1) throw fail(400, "Invalid ticket ID");
  return id;
}
app.get("/api/tickets", async (req, res) => {
  let dept = null;
  if (req.query.department !== undefined) {
    admin(req);
    dept = department(req.query.department, { required: true });
  }
  res.json(await getTickets(req, null, dept));
});
app.get("/api/admin/departments", async (req, res) => {
  admin(req);
  const { rows } = await pool.query(
    `SELECT department AS name,COUNT(*)::int AS total,COUNT(*) FILTER (WHERE status='Open')::int AS open,COUNT(*) FILTER (WHERE status='Queued')::int AS queued,COUNT(*) FILTER (WHERE status='In Progress')::int AS "inProgress",COUNT(*) FILTER (WHERE status='Resolved')::int AS resolved FROM helpdesk_tickets WHERE department IS NOT NULL GROUP BY 1`,
  );
  const empty = { total: 0, open: 0, queued: 0, inProgress: 0, resolved: 0 };
  res.json(DEPARTMENTS.map((name) => ({ ...empty, ...rows.find((r) => r.name === name), name })));
});
app.get("/api/tickets/:id", async (req, res) => {
  // A user asking for someone else's ticket gets the same 404 as a missing one.
  const rows = await getTickets(req, ticketId(req));
  if (!rows.length) throw fail(404, "Ticket not found");
  res.json(rows[0]);
});
app.post("/api/tickets", async (req, res) => {
  const title = text(req.body.title, 150),
    description = text(req.body.description, 10000),
    category = text(req.body.category, 50),
    priority = req.body.priority || "Medium";
  if (
    !["Low", "Medium", "High", "Critical"].includes(priority) ||
    !["Hardware", "Software", "Network", "Account Access", "Other"].includes(
      category,
    )
  )
    throw fail(400, "Invalid category or priority");
  // Every ticket belongs to a department, so one cannot be raised without it.
  if (!req.user.department)
    throw fail(400, "Please set your department in My profile before raising a ticket.");
  let attachment = req.body.attachment || null;
  if (attachment) {
    if (
      typeof attachment.name !== "string" ||
      attachment.name.length > 255 ||
      typeof attachment.dataUrl !== "string" ||
      attachment.dataUrl.length > 2100000 ||
      !/^data:(image\/(png|jpeg|gif|webp)|application\/(pdf|msword|vnd.openxmlformats-officedocument.wordprocessingml.document)|text\/plain);base64,[A-Za-z0-9+/=]+$/.test(
        attachment.dataUrl,
      )
    )
      throw fail(
        400,
        "Unsupported attachment. Use PNG, JPG, GIF, WebP, PDF, DOC, DOCX or TXT under 1.5 MB",
      );
    attachment = {
      name: attachment.name,
      type: attachment.dataUrl.slice(5, attachment.dataUrl.indexOf(";")),
      dataUrl: attachment.dataUrl,
    };
  }
  const c = await pool.connect();
  let id;
  try {
    await c.query("BEGIN");
    const result = await c.query(
      "INSERT INTO helpdesk_tickets(user_id,title,description,category,priority,attachment,department) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [req.user.id, title, description, category, priority, attachment, req.user.department],
    );
    id = result.rows[0].id;
    await c.query(
      "INSERT INTO ticket_updates(ticket_id,author_id,message) VALUES($1,$2,'Ticket submitted')",
      [id, req.user.id],
    );
    const notification = await c.query(
      `INSERT INTO admin_notifications(ticket_id,employee_name,ticket_title,created_at)
       VALUES($1,$2,$3,now()) RETURNING id, ticket_id, employee_name, ticket_title, created_at`,
      [id, req.user.name, title],
    );
    await c.query("SELECT pg_notify('helpdesk_events',$1)", [JSON.stringify({
      id: notification.rows[0].id,
      ticketId: "TKT-" + id,
      employeeName: req.user.name,
      title,
      submittedAt: notification.rows[0].created_at,
    })]);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  try {
    const emailSetting = await pool.query("SELECT setting_value FROM app_settings WHERE setting_key='notification_email_enabled'");
    if (emailSetting.rows[0]?.setting_value === "true" && process.env.ADMIN_NOTIFICATION_EMAIL) {
      sendAccountMail(
        process.env.ADMIN_NOTIFICATION_EMAIL,
        `New support ticket TKT-${id}`,
        `<p>New support ticket submitted.</p><p>Employee: ${req.user.name.replace(/[&<>"]/g, "")}</p><p>Ticket: TKT-${id}</p><p>Issue: ${title.replace(/[&<>"]/g, "")}</p>`
      ).catch((error) => console.error("Admin notification email failed:", error.message));
    }
  } catch (error) {
    console.error("Could not read admin notification preference:", error.message);
  }
  res.status(201).json({ ticket: (await getTickets(req, id))[0] });
});
app.patch("/api/tickets/:id", async (req, res) => {
  admin(req);
  const id = ticketId(req);
  const { status } = req.body;
  if (status === undefined && req.body.department === undefined)
    throw fail(400, "Nothing to update");
  if (status !== undefined && !statuses.includes(status))
    throw fail(400, "Invalid status");
  // A ticket always keeps a department (it cannot be set back to "Unassigned").
  const dept = req.body.department === undefined ? undefined : department(req.body.department, { required: true });
  // The status is overwritten in place (no extra history rows or
  // notifications). Re-selecting the same value changes nothing.
  const r = await pool.query(
    `UPDATE helpdesk_tickets SET status=COALESCE($1,status),department=CASE WHEN $2::boolean THEN $3 ELSE department END,updated_at=now() WHERE id=$4 AND (status IS DISTINCT FROM COALESCE($1,status) OR ($2::boolean AND department IS DISTINCT FROM $3)) RETURNING id`,
    [status ?? null, dept !== undefined, dept ?? null, id],
  );
  const ticket = (await getTickets(req, id))[0];
  if (!ticket) throw fail(404, "Ticket not found");
  // A resolved issue no longer needs an admin notification: tell every open
  // admin panel so it can fade the notification out and update the count.
  if (r.rowCount > 0 && status === "Resolved")
    await pool
      .query("SELECT pg_notify('helpdesk_events',$1)", [JSON.stringify({ type: "resolved", ticketId: "TKT-" + id })])
      .catch((error) => console.error("Resolved event failed:", error.message));
  res.json({ ticket, changed: r.rowCount > 0 });
});
app.post("/api/tickets/:id/messages", async (req, res) => {
  admin(req);
  const id = ticketId(req),
    message = text(req.body.message, 2000);
  const result = await pool.query(
    "INSERT INTO ticket_updates(ticket_id,author_id,message) SELECT id,$2,$3 FROM helpdesk_tickets WHERE id=$1 RETURNING id",
    [id, req.user.id, "IT Support: " + message],
  );
  if (!result.rowCount) throw fail(404, "Ticket not found");
  res.status(201).json({ ticket: (await getTickets(req, id))[0] });
});

// Admin notifications: durable history plus server-pushed updates.
app.get("/api/admin/notifications", async (req, res) => {
  admin(req);
  // Notifications for tickets without a department, and for tickets that are
  // already resolved, are not shown.
  const { rows } = await pool.query(
    "SELECT n.id,'TKT-'||n.ticket_id AS ticket_id,n.employee_name,n.ticket_title,n.created_at,n.read_at FROM admin_notifications n JOIN helpdesk_tickets t ON t.id=n.ticket_id WHERE t.department IS NOT NULL AND t.status <> 'Resolved' ORDER BY n.id DESC LIMIT 100",
  );
  res.json(rows);
});
app.patch("/api/admin/notifications/read", async (req, res) => {
  admin(req);
  await pool.query("UPDATE admin_notifications SET read_at=COALESCE(read_at,now()) WHERE read_at IS NULL");
  res.json({ message: "Notifications marked as read" });
});
// Marks one notification as read (when the admin opens it).
app.patch("/api/admin/notifications/:id/read", async (req, res) => {
  admin(req);
  if (!/^\d{1,15}$/.test(String(req.params.id))) throw fail(400, "Invalid notification ID");
  const result = await pool.query("UPDATE admin_notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1", [Number(req.params.id)]);
  if (!result.rowCount) throw fail(404, "Notification not found");
  res.json({ message: "Notification marked as read" });
});
app.get("/api/admin/events", async (req, res) => {
  admin(req);
  // Acquire the database listener before sending headers so a connection
  // failure becomes a normal error response instead of a hung stream.
  const client = await pool.connect();
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders?.();
  const onNotification = (msg) => {
    if (msg.channel !== "helpdesk_events") return;
    let type = "ticket";
    try {
      if (JSON.parse(msg.payload).type === "resolved") type = "resolved";
    } catch {}
    res.write(`event: ${type}\ndata: ${msg.payload}\n\n`);
  };
  client.on("notification", onNotification);
  let closed = false;
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25000);
  // Serverless hosts (Firebase Hosting -> Cloud Functions) cap request time,
  // so the stream can end itself after SSE_MAX_SECONDS; the admin panel
  // reconnects automatically. 0 = keep open (local server).
  const maxSeconds = Number(process.env.SSE_MAX_SECONDS || 0);
  const limit = maxSeconds > 0 ? setTimeout(() => res.end(), maxSeconds * 1000) : null;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    if (limit) clearTimeout(limit);
    client.removeListener("notification", onNotification);
    try { await client.query("UNLISTEN helpdesk_events"); } catch {}
    client.release();
  };
  res.on("close", cleanup);
  try {
    await client.query("LISTEN helpdesk_events");
    res.write("event: ready\ndata: {}\n\n");
  } catch (error) {
    console.error("Live notification stream failed:", error.message);
    res.end();
  }
});
app.get("/api/admin/employees", async (req, res) => {
  admin(req);
  const { rows } = await pool.query(
    "SELECT id,name,email,employee_id,company,department,role,email_verified,created_at FROM users ORDER BY name"
  );
  res.json(rows);
});
app.get("/api/admin/assets", async (req, res) => {
  admin(req);
  const { rows } = await pool.query("SELECT * FROM assets ORDER BY created_at DESC");
  res.json(rows);
});
const ASSET_TYPES = { Laptop: "LAP", Mouse: "MOU", Keyboard: "KEY", Charger: "CHG" };
// Assigns the selected assets (Laptop, Mouse, Keyboard, Charger) to an employee.
// One register row is created per asset; the tag / serial is generated.
app.post("/api/admin/assets", async (req, res) => {
  admin(req);
  const employeeName = text(req.body.employeeName, 100);
  let employeeId = text(req.body.employeeId, 30).toUpperCase();
  const dept = department(req.body.department, { required: true });
  // "EMP1010" and "EMP-1010" are the same employee: store the registered form.
  const known = await pool.query(
    `SELECT employee_id FROM users WHERE regexp_replace(upper(employee_id),'[^A-Z0-9]','','g')=regexp_replace($1,'[^A-Z0-9]','','g')
     UNION ALL
     SELECT employee_id FROM employee_profiles WHERE regexp_replace(upper(employee_id),'[^A-Z0-9]','','g')=regexp_replace($1,'[^A-Z0-9]','','g')`,
    [employeeId],
  );
  if (known.rows[0]) employeeId = known.rows[0].employee_id;
  const items = Array.isArray(req.body.items) ? [...new Set(req.body.items)] : [];
  if (!items.length || !items.every((item) => ASSET_TYPES[item])) throw fail(400, "Select at least one asset: Laptop, Mouse, Keyboard or Charger");
  const owner = await pool.query("SELECT email FROM users WHERE employee_id=$1", [employeeId]);
  const c = await pool.connect();
  const assets = [];
  try {
    await c.query("BEGIN");
    for (const item of items) {
      const tag = `${ASSET_TYPES[item]}-${employeeId}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`.slice(0, 60);
      const { rows } = await c.query(
        "INSERT INTO assets(name,asset_tag,category,assigned_to,status,employee_name,employee_id,department) VALUES($1,$2,$1,$3,'Assigned',$4,$5,$6) RETURNING *",
        [item, tag, owner.rows[0]?.email || null, employeeName, employeeId, dept],
      );
      assets.push(rows[0]);
    }
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
  res.status(201).json({ assets });
});
// Employee profiles created by the administrator.
app.get("/api/admin/employee-profiles", async (req, res) => {
  admin(req);
  const { rows } = await pool.query(`SELECT ${PROFILE_COLUMNS} FROM employee_profiles ORDER BY id DESC`);
  res.json(rows);
});
app.post("/api/admin/employee-profiles", async (req, res) => {
  admin(req);
  const name = text(req.body.name, 100);
  const employeeId = text(req.body.employeeId, 30).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(employeeId)) throw fail(400, "Employee ID may only contain letters, numbers, hyphens and underscores");
  const email = text(req.body.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) throw fail(400, "Enter a valid employee email address");
  const dept = department(req.body.department, { required: true });
  const idTaken = await pool.query(
    "SELECT 1 FROM employee_profiles WHERE employee_id=$1 UNION ALL SELECT 1 FROM users WHERE employee_id=$1",
    [employeeId],
  );
  if (idTaken.rowCount) throw fail(409, "This Employee ID already exists.");
  const emailTaken = await pool.query(
    "SELECT 1 FROM employee_profiles WHERE lower(email)=$1 UNION ALL SELECT 1 FROM users WHERE lower(email)=$1",
    [email],
  );
  if (emailTaken.rowCount) throw fail(409, "This email address is already registered.");
  const { rows } = await pool.query(
    "INSERT INTO employee_profiles(employee_id,name,email,department) VALUES($1,$2,$3,$4) RETURNING id,employee_id,name,email,department",
    [employeeId, name, email, dept],
  );
  // The profile is saved even if the email cannot be sent; the admin can use
  // "Resend invite" once SMTP works.
  let invitation = { sent: true };
  try {
    await issueInvite(rows[0]);
  } catch (error) {
    console.error("Invitation email failed:", error.message);
    invitation = { sent: false, message: error.message };
  }
  const saved = await pool.query(`SELECT ${PROFILE_COLUMNS} FROM employee_profiles WHERE id=$1`, [rows[0].id]);
  res.status(201).json({ profile: saved.rows[0], invitation });
});
app.post("/api/admin/employee-profiles/:id/resend-invite", async (req, res) => {
  admin(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Invalid profile ID");
  const { rows } = await pool.query("SELECT * FROM employee_profiles WHERE id=$1", [id]);
  const profile = rows[0];
  if (!profile) throw fail(404, "Employee profile not found");
  if (profile.registered_at) throw fail(409, "This employee has already created an account.");
  if (!profile.email) throw fail(400, "This profile has no email address.");
  await issueInvite(profile);
  const saved = await pool.query(`SELECT ${PROFILE_COLUMNS} FROM employee_profiles WHERE id=$1`, [id]);
  res.json({ profile: saved.rows[0], message: `Invitation sent to ${profile.email}.` });
});
app.patch("/api/admin/assets/:id", async (req, res) => {
  admin(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400,"Invalid asset ID");
  const allowed = ["name","asset_tag","category","assigned_to","status","notes"];
  const entries = Object.entries(req.body).filter(([key])=>allowed.includes(key));
  if (!entries.length) throw fail(400,"No valid asset fields supplied");
  const values = entries.map(([,value])=>value);
  const sets = entries.map(([key],i)=>`${key}=$${i+1}`);
  values.push(id);
  const { rows } = await pool.query(`UPDATE assets SET ${sets.join(", ")},updated_at=now() WHERE id=$${values.length} RETURNING *`,values);
  if (!rows[0]) throw fail(404,"Asset not found");
  res.json({asset:rows[0]});
});
app.delete("/api/admin/assets/:id", async (req, res) => {
  admin(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400,"Invalid asset ID");
  const result = await pool.query("DELETE FROM assets WHERE id=$1", [id]);
  if (!result.rowCount) throw fail(404,"Asset not found");
  res.json({message:"Asset deleted"});
});
app.get("/api/admin/settings", async (req, res) => {
  admin(req);
  const { rows } = await pool.query("SELECT setting_key,setting_value FROM app_settings ORDER BY setting_key");
  res.json(Object.fromEntries(rows.map(r=>[r.setting_key,r.setting_value])));
});
app.put("/api/admin/settings", async (req, res) => {
  admin(req);
  const allowed = ["notification_email_enabled","system_name"];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      const value = String(req.body[key]).slice(0,120);
      await pool.query("INSERT INTO app_settings(setting_key,setting_value) VALUES($1,$2) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=now()",[key,value]);
    }
  }
  res.json({message:"Settings saved"});
});
app.use((req, res) => res.status(404).json({ message: "Endpoint not found" }));
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed")
    return res.status(400).json({ message: "Invalid request body" });
  if (err.code === "23505")
    return res.status(409).json({
      message: String(err.constraint || "").includes("asset_tag")
        ? "An asset with this tag / serial already exists."
        : String(err.constraint || "").includes("employee_id")
          ? "This Employee ID already exists."
          : "This email is already registered. Please log in.",
    });
  const status = err.status || 500;
  if (status === 500) console.error(err.message);
  res
    .status(status)
    .json({
      message: status === 500 ? "Server error. Please try again." : err.message,
    });
});
module.exports = { app, hash };