require("./env");
const fs = require("node:fs");
const pool = require("./config/db");
const { hash } = require("./app");
(async () => {
  try {
    await pool.query(
      "CREATE SEQUENCE IF NOT EXISTS employee_number START 1001",
    );
    await pool.query(fs.readFileSync(__dirname + "/schema.sql", "utf8"));
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
      if (process.env.ADMIN_PASSWORD.length < 10)
        throw new Error("Admin password must have at least 10 characters");
      await pool.query(
        "INSERT INTO users(name,email,password_hash,role,email_verified) VALUES('IT Administrator',$1,$2,'admin',true) ON CONFLICT(email) DO NOTHING",
        [
          process.env.ADMIN_EMAIL.toLowerCase(),
          await hash(process.env.ADMIN_PASSWORD),
        ],
      );
    }
    console.log(
      "Database ready. Admin is created only if the email does not already exist.",
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
