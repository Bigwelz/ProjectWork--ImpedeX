/* =============================================
   EIPS — local PostgreSQL dev utility
   =============================================
   Runs a throwaway embedded PostgreSQL 18 for
   local development (NOT for production — use a
   managed PostgreSQL on Render in production).

   Usage (from a NORMAL terminal — needs the
   "Create global objects" privilege, which this
     project's sandboxed shell strips):

     node scripts/pg-local.cjs start    # init + start + create eips db
     node scripts/pg-local.cjs stop     # shut it down
     node scripts/pg-local.cjs status   # is it up?

   After "start", run the app with:
     $env:DATABASE_URL="postgres://postgres@127.0.0.1:5432/eips"
     npm start        # :4000 students
     npm run admin     # :4001 admins
   ============================================= */

"use strict";

const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const TEMP = path.join(os.tmpdir(), "opencode");
const TOOL_DIR = path.join(TEMP, "pgtool");
const PG_PKG = "@embedded-postgres/windows-x64@18.4.0-beta.17";
const PG_DIR = path.join(TOOL_DIR, "node_modules", "@embedded-postgres", "windows-x64", "native", "bin");
const DATA_DIR = path.join(TEMP, "pgdata-eips");
const LOG_FILE = path.join(DATA_DIR, "server.log");
const PORT = 5432;

function bin(name) {
  return path.join(PG_DIR, name);
}

function ensureBinary() {
  if (fs.existsSync(bin("postgres.exe"))) return;
  console.log("embedded PostgreSQL not found — downloading (one time)...");
  fs.mkdirSync(TOOL_DIR, { recursive: true });
  execFileSync("npm.cmd", ["install", PG_PKG, "--prefix", TOOL_DIR], { stdio: "inherit" });
  if (!fs.existsSync(bin("postgres.exe"))) throw new Error("binary download failed");
}

function isUp() {
  try {
    const out = execFileSync(bin("pg_ctl.exe"), ["-D", DATA_DIR, "status"], { encoding: "utf8" });
    return /server is running/i.test(out);
  } catch {
    return false;
  }
}

function ensureDatabase() {
  // No psql in the embedded package — create the DB through a tiny pg client.
  const pg = require(path.join(__dirname, "..", "server", "node_modules", "pg"));
  const c = new pg.Client("postgres://postgres@127.0.0.1:5432/postgres");
  return c
    .connect()
    .then(() => c.query("SELECT 1 FROM pg_database WHERE datname = 'eips'"))
    .then((r) => (r.row.length ? Promise.resolve() : c.query("CREATE DATABASE eips")))
    .then(() => c.end())
    .catch((e) => {
      console.error("Could not create database:", e.message);
      process.exit(1);
    });
}

const cmd = process.argv[2] || "status";

if (cmd === "start") {
  ensureBinary();
  if (isUp()) {
    console.log("PostgreSQL already running on port " + PORT);
  } else {
    if (!fs.existsSync(path.join(DATA_DIR, "PG_VERSION"))) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      execFileSync(bin("initdb.exe"), ["-D", DATA_DIR, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "inherit" });
      console.log("initialised cluster at " + DATA_DIR);
    }
    const child = spawn(bin("pg_ctl.exe"), ["-D", DATA_DIR, "-o", `-p ${PORT} -c listen_addresses=127.0.0.1`, "-l", LOG_FILE, "start"], { detached: true, stdio: "ignore" });
    child.unref();
    console.log("starting PostgreSQL on port " + PORT + " ...");
  }
  const wait = Date.now();
  const poll = () => {
    if (isUp()) {
      ensureDatabase().then(() => {
        console.log("ready — DATABASE_URL=postgres://postgres@127.0.0.1:5432/eips");
      });
    } else if (Date.now() - wait > 25000) {
      console.error("server did not come up — see " + LOG_FILE);
      process.exit(1);
    } else {
      setTimeout(poll, 1000);
    }
  };
  poll();
} else if (cmd === "stop") {
  if (isUp()) execFileSync(bin("pg_ctl.exe"), ["-D", DATA_DIR, "stop", "-m", "fast"], { stdio: "inherit" });
  else console.log("not running");
} else {
  console.log(isUp() ? "PostgreSQL is running on port " + PORT : "PostgreSQL is not running");
}
