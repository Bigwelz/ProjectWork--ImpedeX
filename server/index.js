/* =============================================
   EIPS — Student Server (server/index.js)
   Port 4000: student-facing pages + student API.
   Admin pages and admin API are served ONLY by
   server/admin-server.js on port 4001.
============================================= */

"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("node:path");
const express = require("express");

const db = require("./db");
const { mountApi, normalizePath } = require("./api");

const FRONTEND_DIR = path.join(__dirname, "..");
const PORT = process.env.PORT || 4000;
const ADMIN_PORT = process.env.ADMIN_PORT || 4001;
const ADMIN_URL = (process.env.ADMIN_SITE_URL || `http://localhost:${ADMIN_PORT}`).replace(/\/+$/, "");

const app = express();

/* Student + public endpoints only — no admin route is mounted on this port. */
mountApi(app, { student: true });

/* Never expose server source code or the SQLite database file. */
app.use((req, res, next) => {
  const p = normalizePath(req);
  if (p === "/server" || p.startsWith("/server/")) return res.status(404).send("Not found");
  next();
});

/* Admin pages live on the dedicated admin server — bounce them there. */
app.use((req, res, next) => {
  const p = normalizePath(req);
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (/^admin-.*\.html$/i.test(base)) {
    return res.redirect(ADMIN_URL + req.originalUrl);
  }
  next();
});

app.use(express.static(FRONTEND_DIR));

db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`EIPS student site running at http://localhost:${PORT}`);
    console.log(`Admin portal runs separately at ${ADMIN_URL}`);
    console.log("Serving frontend from " + FRONTEND_DIR);
  });
}).catch((e) => {
  console.error("Failed to initialize database:", e.message);
  process.exit(1);
});
