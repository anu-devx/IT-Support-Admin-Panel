const { Pool } = require("pg");

// DATABASE_SSL=true is needed for most hosted PostgreSQL providers
// (Neon, Supabase, Cloud SQL public IP, Render) unless the URL already
// contains ?sslmode=require.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});
pool.on("error", (error) => console.error("PostgreSQL pool error:", error.message));

module.exports = pool;
