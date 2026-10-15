/* =============================================
   EIPS — Admin Server (server/admin-server.js)
   Port 4001: admin pages + admin API ONLY.
   Student pages are never served from this port,
   and student endpoints are not mounted here.
   Run it beside the student server:
     npm start     → http://localhost:4000 (students)
     npm run admin → http://localhost:4001 (admins)
============================================= */

"use strict";

const path = require("node:path");
const express = require("express");

const { mountApi, normalizePath } = require("./api");
const db = require("./db");

const FRONTEND_DIR = path.join(__dirname, "..");
const ADMIN_PORT = process.env.ADMIN_PORT || 4001;
const STUDENT_PORT = process.env.PORT || 4000;
const STUDENT_URL = (process.env.STUDENT_SITE_URL || `http://localhost:${STUDENT_PORT}`).replace(/\/+$/, "");

const app = express();

/* Admin + public endpoints only — no student route is mounted on this port. */
mountApi(app, { admin: true });

/* Never expose server source code or the database. */
app.use((req, res, next) => {
  const p = normalizePath(req);
  if (p === "/server" || p.startsWith("/server/")) return res.status(404).send("Not found");
  next();
});

/* Portal entry: "/" → admin login. "Back to main site" (index.html) → student site.
   Any other student page requested here is not found on this port. */
app.use((req, res, next) => {
  const p = normalizePath(req);
  if (p === "/") return res.redirect("/admin-login.html");
  if (p === "/index.html") return res.redirect(STUDENT_URL + "/");
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (/\.html$/i.test(base) && !/^admin-.*\.html$/i.test(base)) {
    return res.status(404).send("Not found");
  }
  next();
});

app.use(express.static(FRONTEND_DIR));

db.ready
  .then(() => {
    app.listen(ADMIN_PORT, () => {
      console.log(`EIPS admin portal running at http://localhost:${ADMIN_PORT}`);
      console.log(`Student site runs separately at ${STUDENT_URL}`);
      console.log("Serving admin frontend from " + FRONTEND_DIR);
    });
  })
  .catch((err) => {
    console.error("Failed to initialise PostgreSQL:", err);
    process.exit(1);
  });
