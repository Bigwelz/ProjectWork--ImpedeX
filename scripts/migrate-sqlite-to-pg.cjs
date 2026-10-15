/* =============================================
   EIPS — SQLite → PostgreSQL data migration
   =============================================
   Copies every row from server/eips.db (SQLite)
   into the PostgreSQL database (DATABASE_URL).

   Dry run (no PostgreSQL needed — prints SQL):
     node scripts/migrate-sqlite-to-pg.cjs --dry-run

   Real run:
     $env:DATABASE_URL="postgres://postgres@127.0.0.1:5432/eips"
     node scripts/migrate-sqlite-to-pg.cjs

   NOTE: run the app once against PostgreSQL first so
   schema + seeds are created (db.js does this on
   startup), or let this script create the schema via
   the app — safest order:
     1. start PostgreSQL (scripts/pg-local.cjs start)
     2. node -e "require('./db.js').ready.then(()=>process.exit(0))"   # creates schema+seeds
     3. node scripts/migrate-sqlite-to-pg.cjs                          # copies data
   ============================================= */

"use strict";

const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

const SQLITE_PATH = path.join(__dirname, "..", "server", "eips.db");
const DRY_RUN = process.argv.includes("--dry-run");
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:5432/eips";

/* Insert order respects foreign keys (parents first).
   id columns are preserved with OVERRIDING SYSTEM VALUE
   so identity columns stay consistent. */
const TABLES = [
  ["admin_accounts", ["email", "first_name", "last_name", "phone", "department", "salt", "hash", "access_salt", "access_hash", "created_at"]],
  ["course_catalog", ["code", "title", "unit", "type", "level"]],
  ["students", ["matric", "first_name", "last_name", "email", "phone", "department", "faculty", "level", "session", "password_salt", "password_hash", "photo", "fingerprint_credential_id", "created_at", "registered_at"]],
  ["course_registrations", ["id", "matric", "course_code", "type", "registered_at"]],
  ["exam_selections", ["matric", "course_code", "selected_at"]],
  ["exam_schedules", ["course_code", "date", "time", "hall", "updated_at"]],
  ["seats", ["id", "matric", "course_code", "hall", "seat_number", "row_number", "allocated_at"]],
  ["verification_log", ["id", "matric", "result", "details", "time"]],
  ["carry_overs", ["id", "matric", "course_code", "added_at"]],
  ["otps", ["matric", "salt", "hash", "expires_at", "used"]],
  ["notifications", ["id", "matric", "type", "title", "message", "read", "created_at"]],
];

function buildInsert(table, cols) {
  const hasId = cols[0] === "id";
  const values = cols.map((_, i) => `$${i + 1}`).join(", ");
  const overriding = hasId ? " OVERRIDING SYSTEM VALUE" : "";
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${values})${overriding}`;
}

(async () => {
  if (!require("node:fs").existsSync(SQLITE_PATH)) {
    console.error("No SQLite database at " + SQLITE_PATH);
    process.exit(1);
  }
  const sqlite = new DatabaseSync(SQLITE_PATH);
  console.log("source: " + SQLITE_PATH);

  let pg = null;
  if (!DRY_RUN) {
    const { Client } = require(path.join(__dirname, "node_modules", "pg"));
    pg = new Client(DATABASE_URL);
    await pg.connect();
    console.log("target: " + DATABASE_URL);
  }

  const grand = {};
  try {
    for (const [table, cols] of TABLES) {
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      grand[table] = rows.length;
      if (rows.length === 0) {
        console.log(`  ${table}: 0 rows`);
        continue;
      }
      if (DRY_RUN) {
        const sql = buildInsert(table, cols);
        console.log(`  ${table}: ${rows.length} rows  e.g.`);
        const sample = rows[0];
        const params = cols.map((c) => {
          const v = sample[c];
          if (typeof v === "string" && v.length > 48) return v.slice(0, 45) + "...";
          return v;
        });
        console.log("    " + sql);
        console.log("    " + JSON.stringify(params));
      } else {
        await pg.query("BEGIN");
        try {
          const sql = buildInsert(table, cols);
          for (const row of rows) {
            await pg.query(sql, cols.map((c) => (row[c] === undefined ? null : row[c])));
          }
          await pg.query("COMMIT");
        } catch (e) {
          await pg.query("ROLLBACK");
          throw e;
        }
        console.log(`  ${table}: inserted ${rows.length} rows`);
      }
    }
  } finally {
    sqlite.close();
    if (pg) await pg.end();
  }

  console.log(DRY_RUN ? "\ndry run complete" : "\nmigration complete");
  console.log(JSON.stringify(grand, null, 0));
})().catch((e) => {
  console.error("migration failed:", e.message);
  process.exit(1);
});
