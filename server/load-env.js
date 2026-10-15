/* =============================================
   EIPS — env loader (server/load-env.js)
   Reads ../.env (project root) and sets process.env
   for any key that is NOT already set, so real
   environment variables always win over the file.
   Required first by db.js; covers every server
   because api.js is loaded after it.
   ============================================= */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ENV_PATH = path.join(__dirname, "..", ".env");

try {
  const text = fs.readFileSync(ENV_PATH, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
} catch {
  /* no .env file — rely on real environment variables */
}
